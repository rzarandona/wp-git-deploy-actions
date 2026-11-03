<?php
declare(strict_types=1);

// Off-site CI only. Exact server archive classes are retained under shared/.
spl_autoload_register(static function (string $class): void {
    $prefix = 'DeployAgent\\Core\\';
    if (str_starts_with($class, $prefix)) {
        require dirname(__DIR__) . '/shared/Core/' . str_replace('\\', '/', substr($class, strlen($prefix))) . '.php';
    }
});
try {
    foreach (['zip', 'intl', 'mbstring', 'zlib'] as $extension) {
        if (!extension_loaded($extension)) throw new RuntimeException('package validator needs PHP extension ' . $extension);
    }
    if (PHP_INT_SIZE !== 8) throw new RuntimeException('package validator needs 64-bit PHP');
    $context = json_decode($argv[3], true, 8, JSON_THROW_ON_ERROR);
    (new DeployAgent\Core\Archive\PackageValidator())->validate($argv[1], $argv[2], $context);
    echo "accepted server archive policy: PASS\n";
} catch (Throwable $error) {
    fwrite(STDERR, 'package validation refused: ' . $error->getMessage() . "\n");
    exit(1);
}
