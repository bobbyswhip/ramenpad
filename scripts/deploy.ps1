param(
  [string]$RpcUrl = "https://rpc.mainnet.chain.robinhood.com",
  [string]$RamenDev = ""
)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$keystore = Join-Path $repo "secrets\ramenpad-deployer"
$passwordFile = Join-Path $repo "secrets\ramenpad-deployer.password"
$backendSecrets = Join-Path $repo "secrets\.env.backend"

foreach ($path in @($keystore, $passwordFile, $backendSecrets)) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing required secret: $path" }
  if (-not (Resolve-Path -LiteralPath $path).Path.StartsWith($repo, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Secret path escaped the RamenPad project."
  }
}

$owner = (cast wallet address --keystore $keystore --password-file $passwordFile).Trim()
$quoteSignerLine = Get-Content -LiteralPath $backendSecrets | Where-Object { $_ -like "RAMENPAD_QUOTE_SIGNER_ADDRESS=*" } | Select-Object -First 1
$quoteSigner = ($quoteSignerLine -split "=", 2)[1].Trim()
if ($owner -notmatch "^0x[0-9a-fA-F]{40}$" -or $quoteSigner -notmatch "^0x[0-9a-fA-F]{40}$") {
  throw "Owner or quote signer address is invalid."
}
if (-not $RamenDev) { $RamenDev = $owner }
if ($RamenDev -notmatch "^0x[0-9a-fA-F]{40}$") { throw "Ramen dev address is invalid." }

Write-Host "Deploying RamenPad on Robinhood Chain (4663)"
Write-Host "Owner/deployer: $owner"
Write-Host "Quote signer:   $quoteSigner"
Write-Host "Ramen dev:      $RamenDev"

try {
  $env:RAMENPAD_DEPLOYER_PRIVATE_KEY = (cast wallet private-key --keystore $keystore --password-file $passwordFile).Trim()
  $env:RAMENPAD_OWNER_ADDRESS = $owner
  $env:RAMENPAD_DEV_ADDRESS = $RamenDev
  $env:RAMENPAD_QUOTE_SIGNER_ADDRESS = $quoteSigner
  $env:ROBINHOOD_RPC_URL = $RpcUrl
  forge script contracts/script/DeployRamenPad.s.sol:DeployRamenPad --rpc-url $RpcUrl --broadcast -vvvv --root $repo
  if ($LASTEXITCODE -ne 0) { throw "Foundry deployment failed." }

  $broadcastPath = Join-Path $repo "broadcast\DeployRamenPad.s.sol\4663\run-latest.json"
  $run = Get-Content -Raw -LiteralPath $broadcastPath | ConvertFrom-Json
  $launcherTx = $run.transactions | Where-Object { $_.contractName -eq "RamenLauncher" } | Select-Object -Last 1
  $launcherAddress = $launcherTx.contractAddress
  if ($launcherAddress -notmatch "^0x[0-9a-fA-F]{40}$") { throw "Launcher address missing from broadcast output." }
  $lockerAddress = (cast call $launcherAddress "locker()(address)" --rpc-url $RpcUrl).Trim()
  $otcAddress = (cast call $launcherAddress "otc()(address)" --rpc-url $RpcUrl).Trim()

  $addressPath = Join-Path $repo "deployment\addresses.json"
  $addresses = Get-Content -Raw -LiteralPath $addressPath | ConvertFrom-Json
  $addresses.launcher = $launcherAddress
  $addresses.liquidityLocker = $lockerAddress
  $addresses.otc = $otcAddress
  $addresses.ramenDev = $RamenDev
  [IO.File]::WriteAllText($addressPath, ($addresses | ConvertTo-Json -Depth 8) + [Environment]::NewLine)
  Write-Host "Launcher: $launcherAddress"
  Write-Host "Locker:   $lockerAddress"
  Write-Host "OTC:      $otcAddress"
} finally {
  Remove-Item Env:RAMENPAD_DEPLOYER_PRIVATE_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:RAMENPAD_DEV_ADDRESS -ErrorAction SilentlyContinue
}
