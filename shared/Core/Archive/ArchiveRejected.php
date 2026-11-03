<?php

declare(strict_types=1);

namespace DeployAgent\Core\Archive;

use DeployAgent\Core\Errors\ErrorCode;

final class ArchiveRejected extends \RuntimeException
{
    public function __construct(
        public readonly ErrorCode $errorCode,
        public readonly string $normativeRule,
        string $reason,
    ) {
        parent::__construct($reason);
    }
}
