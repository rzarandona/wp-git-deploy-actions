<?php

declare(strict_types=1);

namespace DeployAgent\Core\Archive;

use DeployAgent\Core\Errors\ErrorCode;

/** Dependency-free ZIP structure parser used independently from libzip (§I.2). */
final class ZipInspector
{
    /** @return array{entries: list<array<string, int|string>>, comment: string} */
    public function inspect(string $bytes): array
    {
        $length = \strlen($bytes);
        if ($length < 22) {
            $this->reject('archive shorter than EOCD');
        }
        $eocd = $this->findEocd($bytes);
        $tail = $this->fields($bytes, $eocd + 4, 'vdisk/vcd_disk/ventries_disk/ventries/Vcd_size/Vcd_offset/vcomment_len');
        if ($eocd + 22 + $tail['comment_len'] !== $length) {
            $this->reject('EOCD does not account for final bytes');
        }
        $comment = \substr($bytes, $eocd + 22, $tail['comment_len']);
        if ($tail['comment_len'] > 1024) {
            $this->reject('ZIP comment exceeds 1 KB');
        }
        if (\str_contains($comment, "PK\x05\x06") || \str_contains($comment, "PK\x06\x06")
            || \str_contains($comment, "PK\x06\x07")) {
            $this->reject('ZIP comment contains a record signature');
        }
        if ($tail['disk'] !== 0 || $tail['cd_disk'] !== 0 || $tail['entries_disk'] !== $tail['entries']) {
            $this->reject('multi-disk archive');
        }

        $count = $tail['entries'];
        $cdSize = $tail['cd_size'];
        $cdOffset = $tail['cd_offset'];
        $zip64 = $count === 0xffff || $cdSize === 0xffffffff || $cdOffset === 0xffffffff;
        $postCdStart = $eocd;
        if ($zip64) {
            if ($eocd < 20 || \substr($bytes, $eocd - 20, 4) !== "PK\x06\x07") {
                $this->reject('missing ZIP64 locator');
            }
            $locator = $this->fields($bytes, $eocd - 16, 'Vdisk/Voffset_low/Voffset_high/Vdisks');
            if ($locator['disk'] !== 0 || $locator['disks'] !== 1 || $locator['offset_high'] !== 0) {
                $this->reject('invalid ZIP64 locator');
            }
            $zip64Offset = $locator['offset_low'];
            if (\substr($bytes, $zip64Offset, 4) !== "PK\x06\x06") {
                $this->reject('missing ZIP64 EOCD');
            }
            $z = $this->fields($bytes, $zip64Offset + 16, 'Vdisk/Vcd_disk');
            if ($z['disk'] !== 0 || $z['cd_disk'] !== 0) {
                $this->reject('ZIP64 multi-disk archive');
            }
            $countDisk = $this->u64At($bytes, $zip64Offset + 24);
            $count = $this->u64At($bytes, $zip64Offset + 32);
            $cdSize = $this->u64At($bytes, $zip64Offset + 40);
            $cdOffset = $this->u64At($bytes, $zip64Offset + 48);
            if ($count !== $countDisk || $zip64Offset + 56 !== $eocd - 20) {
                $this->reject('inconsistent ZIP64 EOCD');
            }
            $postCdStart = $zip64Offset;
        } elseif ($eocd >= 20 && \substr($bytes, $eocd - 20, 4) === "PK\x06\x07") {
            $this->reject('unneeded ZIP64 records');
        }
        if ($count > 20001) {
            $this->reject('implausible central entry count');
        }
        $this->range($cdOffset, $cdSize, $length);
        if ($cdOffset + $cdSize !== $postCdStart) {
            $this->reject('central directory is not contiguous with end records');
        }

        $cursor = $cdOffset;
        $entries = [];
        for ($i = 0; $i < $count; ++$i) {
            if (\substr($bytes, $cursor, 4) !== "PK\x01\x02") {
                $this->reject('central record signature missing');
            }
            $c = $this->fields($bytes, $cursor + 4,
                'vmade/vneeded/vflags/vmethod/vtime/vdate/Vcrc/Vcsize/Vusize/vname_len/vextra_len/vcomment_len/vdisk/vinternal/Vexternal/Voffset');
            $recordLength = 46 + $c['name_len'] + $c['extra_len'] + $c['comment_len'];
            $this->range($cursor, $recordLength, $length);
            $name = \substr($bytes, $cursor + 46, $c['name_len']);
            $extra = \substr($bytes, $cursor + 46 + $c['name_len'], $c['extra_len']);
            $extraFields = $this->extraFields($extra);
            $csize = $c['csize'];
            $usize = $c['usize'];
            $zipValues = $extraFields[0x0001] ?? null;
            $zipCursor = 0;
            if ($usize === 0xffffffff) {
                $usize = $this->u64AtRequired($zipValues, $zipCursor);
                $zipCursor += 8;
            }
            if ($csize === 0xffffffff) {
                $csize = $this->u64AtRequired($zipValues, $zipCursor);
                $zipCursor += 8;
            }
            $offset = $c['offset'];
            if ($offset === 0xffffffff) {
                $offset = $this->u64AtRequired($zipValues, $zipCursor);
                $zipCursor += 8;
            }
            if ($zipValues !== null && $zipCursor === 0) {
                $this->reject('unneeded ZIP64 extra');
            }
            if ($c['disk'] !== 0) {
                $this->reject('central entry is on another disk');
            }
            if (($c['flags'] & 0x0041) !== 0 || !\in_array($c['method'], [0, 8], true)) {
                $this->reject('encryption or unsupported compression');
            }
            $entries[] = [
                'name' => $name,
                'flags' => $c['flags'],
                'method' => $c['method'],
                'time' => $c['time'],
                'date' => $c['date'],
                'crc' => $c['crc'],
                'csize' => $csize,
                'usize' => $usize,
                'offset' => $offset,
                'external' => $c['external'],
                'made' => $c['made'],
                'central_index' => $i,
                'zip64_values' => $zipCursor > 0 ? 1 : 0,
            ];
            $cursor += $recordLength;
        }
        if ($cursor !== $cdOffset + $cdSize) {
            $this->reject('central directory size mismatch');
        }

        $entriesByOffset = $entries;
        \usort($entriesByOffset, static fn (array $a, array $b): int => $a['offset'] <=> $b['offset']);
        $expectedOffset = 0;
        foreach ($entriesByOffset as &$entry) {
            if ($entry['offset'] > $expectedOffset) {
                $this->reject('local records have prepended bytes or a gap');
            }
            if ($entry['offset'] < $expectedOffset) {
                $this->reject('central entries overlap a local range');
            }
            if (\substr($bytes, $entry['offset'], 4) !== "PK\x03\x04") {
                $this->reject('local record signature missing');
            }
            $local = $this->fields($bytes, $entry['offset'] + 4,
                'vneeded/vflags/vmethod/vtime/vdate/Vcrc/Vcsize/Vusize/vname_len/vextra_len');
            $localName = \substr($bytes, $entry['offset'] + 30, $local['name_len']);
            $localExtra = \substr($bytes, $entry['offset'] + 30 + $local['name_len'], $local['extra_len']);
            $localExtraFields = $this->extraFields($localExtra);
            $localCsize = $local['csize'];
            $localUsize = $local['usize'];
            $localZipCursor = 0;
            if ($localUsize === 0xffffffff) {
                $localUsize = $this->u64AtRequired($localExtraFields[0x0001] ?? null, $localZipCursor);
                $localZipCursor += 8;
            }
            if ($localCsize === 0xffffffff) {
                $localCsize = $this->u64AtRequired($localExtraFields[0x0001] ?? null, $localZipCursor);
            }
            if ($localName !== $entry['name'] || $local['flags'] !== $entry['flags'] || $local['method'] !== $entry['method']) {
                $this->reject('local and central headers disagree');
            }
            $descriptor = ($entry['flags'] & 0x0008) !== 0;
            if (!$descriptor && ($local['crc'] !== $entry['crc'] || $localCsize !== $entry['csize'] || $localUsize !== $entry['usize'])) {
                if ($entry['zip64_values'] === 1 && ($localCsize !== $entry['csize'] || $localUsize !== $entry['usize'])) {
                    $this->reject('ZIP64 local and central sizes disagree');
                }
                $this->reject('local CRC or sizes disagree');
            }
            $dataStart = $entry['offset'] + 30 + $local['name_len'] + $local['extra_len'];
            $dataEnd = $this->checkedAdd($dataStart, $entry['csize']);
            $this->range($dataStart, $entry['csize'], $length);
            $entry['data_start'] = $dataStart;
            $entry['data_end'] = $dataEnd;
            $entry['data'] = \substr($bytes, $dataStart, $entry['csize']);
            $expectedOffset = $dataEnd;
            if ($descriptor) {
                $hasSignature = \substr($bytes, $expectedOffset, 4) === "PK\x07\x08";
                $dd = $this->fields($bytes, $expectedOffset + ($hasSignature ? 4 : 0), 'Vcrc/Vcsize/Vusize');
                if ($dd['crc'] !== $entry['crc'] || $dd['csize'] !== $entry['csize'] || $dd['usize'] !== $entry['usize']) {
                    $this->reject('data descriptor disagrees');
                }
                $expectedOffset += $hasSignature ? 16 : 12;
            }
            $entries[$entry['central_index']] = $entry;
        }
        unset($entry);
        if ($expectedOffset > $cdOffset) {
            $this->reject('central directory overlaps local data');
        }
        if ($expectedOffset < $cdOffset) {
            $this->reject('local data is not contiguous with central directory');
        }
        return ['entries' => $entries, 'comment' => $comment];
    }

    private function findEocd(string $bytes): int
    {
        $start = \max(0, \strlen($bytes) - 65557);
        for ($offset = \strlen($bytes) - 22; $offset >= $start; --$offset) {
            if (\substr($bytes, $offset, 4) === "PK\x05\x06") {
                $length = $this->fields($bytes, $offset + 20, 'vlength')['length'];
                if ($offset + 22 + $length === \strlen($bytes)) {
                    return $offset;
                }
            }
        }
        $this->reject('EOCD missing or trailing bytes present');
    }

    /** @return array<string, int> */
    private function fields(string $bytes, int $offset, string $format): array
    {
        $result = @\unpack($format, \substr($bytes, $offset));
        if (!\is_array($result)) {
            $this->reject('truncated ZIP record');
        }
        return $result;
    }

    /** @return array<int, string> */
    private function extraFields(string $extra): array
    {
        $fields = [];
        $cursor = 0;
        while ($cursor < \strlen($extra)) {
            if ($cursor + 4 > \strlen($extra)) {
                $this->reject('truncated extra field');
            }
            $header = $this->fields($extra, $cursor, 'vid/vlen');
            $cursor += 4;
            if ($cursor + $header['len'] > \strlen($extra) || !\in_array($header['id'], [0x0001, 0x5455, 0x7875, 0x000a], true)
                || isset($fields[$header['id']])) {
                $this->reject('forbidden or malformed extra field');
            }
            $fields[$header['id']] = \substr($extra, $cursor, $header['len']);
            $cursor += $header['len'];
        }
        return $fields;
    }

    private function u64At(string $bytes, int $offset): int
    {
        $parts = @\unpack('Vlow/Vhigh', \substr($bytes, $offset, 8));
        if (!\is_array($parts) || $parts['high'] > 0x7fffffff) {
            $this->reject('64-bit value overflows signed PHP integer');
        }
        return $parts['high'] * 4294967296 + $parts['low'];
    }

    private function u64AtRequired(?string $bytes, int $offset): int
    {
        if ($bytes === null || $offset + 8 > \strlen($bytes)) {
            $this->reject('required ZIP64 value missing');
        }
        return $this->u64At($bytes, $offset);
    }

    private function checkedAdd(int $a, int $b): int
    {
        if ($a < 0 || $b < 0 || $a > \PHP_INT_MAX - $b) {
            $this->reject('checked 64-bit addition overflow');
        }
        return $a + $b;
    }

    private function range(int $offset, int $length, int $total): void
    {
        $end = $this->checkedAdd($offset, $length);
        if ($offset < 0 || $length < 0 || $end > $total) {
            $this->reject('ZIP range is outside the file');
        }
    }

    private function reject(string $reason): never
    {
        $rule = match ($reason) {
            'ZIP comment exceeds 1 KB' => '2 structure / 9a',
            'ZIP comment contains a record signature',
            'central directory is not contiguous with end records',
            'local records have prepended bytes or a gap',
            'data descriptor disagrees',
            'local data is not contiguous with central directory' => '9a byte accounting',
            'missing ZIP64 locator', 'invalid ZIP64 locator', 'missing ZIP64 EOCD', 'ZIP64 multi-disk archive',
            'inconsistent ZIP64 EOCD', 'unneeded ZIP64 records', 'unneeded ZIP64 extra',
            '64-bit value overflows signed PHP integer', 'required ZIP64 value missing',
            'ZIP64 local and central sizes disagree', 'checked 64-bit addition overflow' => '3 ZIP64',
            'truncated extra field', 'forbidden or malformed extra field' => '4 extra fields',
            default => '2 structure',
        };
        throw new ArchiveRejected(ErrorCode::ARTIFACT_INVALID_ARCHIVE, $rule, $reason);
    }
}
