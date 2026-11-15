param([Parameter(Mandatory=$true)][string]$Source,[Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
$files = @('main.js','styles.css','manifest.json') | ForEach-Object { Join-Path $Source $_ }
Compress-Archive -LiteralPath $files -DestinationPath $Destination -Force
