<?php

declare(strict_types=1);

namespace DeployAgent\Core\Archive;

use DeployAgent\Core\Errors\ErrorCode;
use DeployAgent\Core\Ports\LibzipReader;
use DeployAgent\Core\Ports\ZipReader;
use Normalizer;

/** Enforces the complete normative package policy and two-parser agreement. */
final class PackageValidator
{
    public function __construct(private readonly ZipReader $reader = new LibzipReader())
    {
    }

    /** @param array<string, mixed> $context */
    public function validate(string $path, string $expectedSha256, array $context): ValidatedPackage
    {
        return $this->validateArchive($path, $expectedSha256, $context, false);
    }

    /** Snapshot profile: the same ZIP/name/limit agreement, without package hygiene or headers. */
    public function validateSnapshot(string $path, string $expectedSha256, string $destinationRoot): ValidatedPackage
    {
        return $this->validateArchive($path, $expectedSha256, ['target_root' => $destinationRoot], true);
    }

    /** @param array<string,mixed> $context */
    private function validateArchive(string $path, string $expectedSha256, array $context, bool $snapshot): ValidatedPackage
    {
        $actual = @\hash_file('sha256', $path);
        if (!\is_string($actual) || !\hash_equals($expectedSha256, $actual)) {
            throw new ArchiveRejected(ErrorCode::ARTIFACT_CHECKSUM_MISMATCH, '1 integrity', 'pre-open hash mismatch');
        }
        $bytes = @\file_get_contents($path);
        if (!\is_string($bytes)) {
            throw new ArchiveRejected(ErrorCode::ARTIFACT_INVALID_ARCHIVE, '2 structure', 'archive cannot be read');
        }
        $inspection = (new ZipInspector())->inspect($bytes);
        $this->checkPolicy($inspection, $context, $snapshot);
        $this->assertLibzipAgreement($path, $inspection);
        foreach ($inspection['entries'] as &$entry) {
            unset($entry['data']);
        }
        unset($entry);
        return new ValidatedPackage($path, $actual, $inspection['entries']);
    }

    /**
     * @param array{entries: list<array<string, int|string>>, comment: string} $inspection
     * @param array<string, mixed> $context
     */
    private function checkPolicy(array $inspection, array $context, bool $snapshot): void
    {
        $entries = $inspection['entries'];
        if (\count($entries) > 20000) {
            $this->reject('entry limit exceeded');
        }
        $expanded = 0;
        $casefold = [];
        $files = [];
        $entryPaths = [];
        $contentEntries = [];
        foreach ($entries as $entry) {
            $name = (string) $entry['name'];
            $usize = (int) $entry['usize'];
            $csize = (int) $entry['csize'];
            $expanded = $this->checkedAdd($expanded, $usize);
            if ($usize > 128 * 1024 * 1024 || ($usize > 1024 * 1024 && ($csize === 0 || $usize / $csize > 200))) {
                $this->reject('entry size or ratio limit exceeded');
            }
            $isDirectory = \str_ends_with($name, '/');
            $dosDirectory = (((int) $entry['external']) & 0x10) !== 0;
            $madeByUnix = ((((int) $entry['made']) >> 8) & 0xff) === 3;
            $type = (((int) $entry['external']) >> 16) & 0170000;
            if (($madeByUnix && !\in_array($type, [0, 0040000, 0100000], true)) || $dosDirectory !== $isDirectory) {
                $this->reject('unsupported entry type');
            }
            $this->checkName($name, (int) $entry['flags'], $context, $snapshot);
            $folded = \mb_convert_case($name, \MB_CASE_FOLD, 'UTF-8');
            if (isset($casefold[$folded])) {
                $this->reject('case-fold collision');
            }
            $casefold[$folded] = true;
            $trimmed = \rtrim($name, '/');
            $entryPaths[] = $trimmed;
            if (!$isDirectory) {
                $files[$folded] = true;
                $contentEntries[$name] = $entry;
            }
            if (!$snapshot) {
                $this->checkHygiene($name, (bool) $context['allow_server_config']);
            }
        }
        foreach ($entryPaths as $path) {
            $parts = \explode('/', $path);
            for ($i = 1; $i < \count($parts); ++$i) {
                $prefix = \implode('/', \array_slice($parts, 0, $i));
                if (isset($files[\mb_convert_case($prefix, \MB_CASE_FOLD, 'UTF-8')])) {
                    $this->reject('file collides with directory prefix');
                }
            }
        }
        if ($expanded > 512 * 1024 * 1024) {
            $this->reject('expanded size limit exceeded');
        }
        if ($snapshot) {
            return;
        }
        if (\in_array($context['slug'], $context['protected_slugs'], true)) {
            $this->reject('self-protected slug');
        }
        $contents = [];
        foreach ($contentEntries as $name => $entry) {
            $contents[$name] = $this->content($entry);
        }
        if ($context['component'] === 'plugin') {
            $main = $context['slug'] . '/' . $context['plugin_file'];
            if (!isset($contents[$main]) || !\preg_match('/^[ \t\/*#@]*Plugin Name\s*:/mi', $contents[$main])) {
                $this->reject('plugin header missing');
            }
            if (\preg_match('/^[ \t\/*#@]*Requires PHP\s*:\s*([^\r\n]+)/mi', $contents[$main], $match)
                && \version_compare(\trim($match[1]), (string) $context['site_php'], '>')) {
                throw new ArchiveRejected(ErrorCode::REQUIREMENTS_UNMET, '10 structure and headers', 'PHP requirement unmet');
            }
            if (\preg_match('/^[ \t\/*#@]*Requires at least\s*:\s*([^\r\n]+)/mi', $contents[$main], $match)
                && \version_compare(\trim($match[1]), (string) $context['site_wordpress'], '>')) {
                throw new ArchiveRejected(ErrorCode::REQUIREMENTS_UNMET, '10 structure and headers', 'WordPress requirement unmet');
            }
        } else {
            $style = $context['slug'] . '/style.css';
            if (!isset($contents[$style]) || !\preg_match('/^[ \t\/*#@]*Theme Name\s*:/mi', $contents[$style])) {
                $this->reject('theme header missing');
            }
            if (\preg_match('/^[ \t\/*#@]*Template\s*:\s*([^\r\n]+)/mi', $contents[$style], $match)
                && !\in_array(\trim($match[1]), $context['installed_parents'], true)) {
                $this->reject('theme parent missing');
            }
        }
    }

    /** @param array<string, int|string> $entry */
    private function content(array $entry): string
    {
        $content = (int) $entry['method'] === 0 ? (string) $entry['data'] : @\gzinflate((string) $entry['data']);
        if (!\is_string($content) || \strlen($content) !== (int) $entry['usize']
            || (int) \hexdec(\hash('crc32b', $content)) !== (int) $entry['crc']) {
            $this->reject('uncompressed size or CRC mismatch');
        }
        return $content;
    }

    /** @param array<string, mixed> $context */
    private function checkName(string $name, int $flags, array $context, bool $snapshot): void
    {
        $nonAscii = \preg_match('/[\x80-\xFF]/', $name) === 1;
        if ($nonAscii && (($flags & 0x0800) === 0 || !\mb_check_encoding($name, 'UTF-8') || !Normalizer::isNormalized($name, Normalizer::FORM_C))) {
            $this->reject('invalid Unicode name');
        }
        if (\preg_match('/[\x00-\x1F\x7F]/', $name) || \str_contains($name, '\\') || \str_starts_with($name, '/')
            || \preg_match('/^[A-Za-z]:/', $name) || \str_starts_with($name, '//')) {
            $this->reject('unsafe absolute or control-character name');
        }
        if ($snapshot) {
            try {
                (new SnapshotProfileValidator())->validateName(\rtrim($name, '/'), (string) $context['target_root']);
            } catch (\DeployAgent\Core\Errors\AgentException) {
                $this->reject('unsafe path segment');
            }
            return;
        }
        $parts = \explode('/', \rtrim($name, '/'));
        if ($parts === [] || $parts[0] !== $context['slug'] || \count($parts) > 32) {
            $this->reject('wrong top-level directory or depth');
        }
        foreach ($parts as $part) {
            if ($part === '' || $part === '.' || $part === '..' || \strlen($part) > 255 || \preg_match('/[. ]$/', $part)
                || \preg_match('/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i', $part)) {
                $this->reject('unsafe path segment');
            }
        }
        $relative = \implode('/', \array_slice($parts, 1));
        if (\strlen($relative) > 240 || \strlen((string) $context['target_root'] . '/' . $name) > 1024
            || \strlen((string) $context['target_root'] . '/' . $name) >= \PHP_MAXPATHLEN) {
            $this->reject('path length limit exceeded');
        }
    }

    private function checkHygiene(string $name, bool $allowServerConfig): void
    {
        $lower = \strtolower($name);
        $parts = \explode('/', $lower);
        $base = \end($parts);
        if (\in_array($base, ['.user.ini', 'php.ini', '.env'], true)
            || (!$allowServerConfig && \in_array($base, ['.htaccess', 'web.config'], true))
            || \preg_match('/\.(?:pem|key|p12|pfx|phar)$/i', $base)
            || \array_intersect($parts, ['.git', '.svn', '.hg'])
            || \str_contains('/' . $lower . '/', '/vendor/phpunit/')) {
            $this->reject('hygiene policy denied entry');
        }
    }

    /** @param array{entries: list<array<string, int|string>>, comment: string} $inspection */
    private function assertLibzipAgreement(string $path, array $inspection): void
    {
        if (!$this->reader->open($path)) {
            $this->rejectAgreement('libzip rejected archive');
        }
        try {
            if ($this->reader->entryCount() !== \count($inspection['entries'])) {
                $this->rejectAgreement('entry count disagreed');
            }
            foreach ($inspection['entries'] as $index => $entry) {
                $observed = $this->reader->entry($index);
                $expected = [
                    'name' => $entry['name'], 'index' => $index, 'crc' => $entry['crc'],
                    'size' => $entry['usize'], 'comp_size' => $entry['csize'], 'comp_method' => $entry['method'],
                ];
                if ($observed === null) {
                    $this->rejectAgreement('libzip stat failed');
                }
                foreach ($expected as $field => $value) {
                    if (!\array_key_exists($field, $observed) || $observed[$field] !== $value) {
                        $this->rejectAgreement('libzip metadata disagreement for ' . $field);
                    }
                }
                $stream = $this->reader->stream($index);
                if (!\is_resource($stream)) {
                    $this->rejectAgreement('libzip could not stream entry by index');
                }
                $crc = \hash_init('crc32b');
                $size = 0;
                while (!\feof($stream)) {
                    $chunk = \fread($stream, 1024 * 1024);
                    if (!\is_string($chunk)) {
                        \fclose($stream);
                        $this->rejectAgreement('libzip stream read failed');
                    }
                    $size += \strlen($chunk);
                    \hash_update($crc, $chunk);
                }
                \fclose($stream);
                if ($size !== (int) $entry['usize'] || (int) \hexdec(\hash_final($crc)) !== (int) $entry['crc']) {
                    $this->rejectAgreement('libzip index stream bytes disagree');
                }
            }
        } finally {
            $this->reader->close();
        }
    }

    private function checkedAdd(int $a, int $b): int
    {
        if ($a < 0 || $b < 0 || $a > \PHP_INT_MAX - $b) {
            $this->reject('checked package total overflow');
        }
        return $a + $b;
    }

    private function reject(string $reason): never
    {
        $rule = match ($reason) {
            'entry limit exceeded', 'entry size or ratio limit exceeded', 'expanded size limit exceeded',
            'checked package total overflow' => '8 limits',
            'unsupported entry type' => '5 entry types',
            'case-fold collision', 'file collides with directory prefix' => '7 collisions',
            'self-protected slug' => '12 self-protection',
            'plugin header missing', 'theme header missing', 'theme parent missing' => '10 structure and headers',
            'invalid Unicode name', 'unsafe absolute or control-character name', 'wrong top-level directory or depth',
            'unsafe path segment', 'path length limit exceeded' => '6 names',
            'hygiene policy denied entry' => '11 hygiene',
            default => '2 structure',
        };
        throw new ArchiveRejected(ErrorCode::ARTIFACT_INVALID_ARCHIVE, $rule, $reason);
    }

    private function rejectAgreement(string $reason): never
    {
        throw new ArchiveRejected(ErrorCode::ARTIFACT_INVALID_ARCHIVE, 'two-parser agreement', $reason);
    }
}
