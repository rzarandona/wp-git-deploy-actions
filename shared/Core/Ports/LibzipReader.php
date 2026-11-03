<?php

declare(strict_types=1);

namespace DeployAgent\Core\Ports;

final class LibzipReader implements ZipReader
{
    private ?\ZipArchive $zip = null;

    public function open(string $path): bool
    {
        if (!\class_exists(\ZipArchive::class)) {
            return false;
        }
        $zip = new \ZipArchive();
        if ($zip->open($path, \ZipArchive::CHECKCONS | \ZipArchive::RDONLY) !== true) {
            return false;
        }
        $this->zip = $zip;
        return true;
    }

    public function entryCount(): int
    {
        return $this->zip?->count() ?? 0;
    }

    public function entry(int $index): ?array
    {
        $stat = $this->zip?->statIndex($index, \ZipArchive::FL_UNCHANGED);
        if (!\is_array($stat)) {
            return null;
        }
        return [
            'name' => (string) $stat['name'],
            'size' => (int) $stat['size'],
            'comp_size' => (int) $stat['comp_size'],
            'crc' => (int) $stat['crc'],
            'comp_method' => (int) $stat['comp_method'],
            'index' => (int) $stat['index'],
        ];
    }

    public function stream(int $index): mixed
    {
        $stream = $this->zip?->getStreamIndex($index);
        return \is_resource($stream) ? $stream : null;
    }

    public function close(): void
    {
        $this->zip?->close();
        $this->zip = null;
    }
}
