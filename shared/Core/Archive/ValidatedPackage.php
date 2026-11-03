<?php

declare(strict_types=1);

namespace DeployAgent\Core\Archive;

final class ValidatedPackage
{
    /**
     * @param list<array<string, int|string>> $entries
     */
    public function __construct(
        public readonly string $path,
        public readonly string $sha256,
        public readonly array $entries,
    ) {
    }
}
