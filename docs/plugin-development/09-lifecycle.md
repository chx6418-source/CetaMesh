# 09 Lifecycle

The Owner stages a package, reviews manifest, scan, and permissions, then installs it disabled. Enable is a separate action. The Runtime registers capabilities while enabled and withdraws them on disable. A crash is reported and can leave the extension disabled.

Updates are staged and reviewed; added permissions require another review. Rollback also passes Runtime review. Uninstall can keep files; user data is not automatically deleted. Local plugins require Developer Mode and an additional first-enable Owner Review.
