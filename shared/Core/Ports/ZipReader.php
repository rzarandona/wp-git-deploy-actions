<?php
/**
 * ZipReader port (Slice 0A defines the port; the ZipInspector and the
 * two-parser agreement of §I.2 are built in Slice 5).
 */

declare(strict_types=1);

namespace DeployAgent\Core\Ports;

interface ZipReader
{
    /** Opens read-only with consistency checks (CHECKCONS | RDONLY). */
    public function open(string $path): bool;

    public function entryCount(): int;

    /**
     * @return array{name:string,size:int,comp_size:int,crc:int,comp_method:int,index:int}|null
     */
    public function entry(int $index): ?array;

    /** A read stream for one entry, by index only. @return resource|null */
    public function stream(int $index): mixed;

    public function close(): void;
}
