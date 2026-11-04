# Read-only observer. Its owning Node supervisor enforces the total deadline,
# output budget and exact helper cleanup. This script never controls a service.
$ErrorActionPreference='Stop'
Set-StrictMode -Version 2.0
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
[Console]::InputEncoding=New-Object Text.UTF8Encoding($false)
function Write-Unknown { [Console]::Out.WriteLine('{"schemaVersion":1,"complete":false,"reason":"QUERY_FAILED"}') }
try {
    $inputText=New-Object Text.StringBuilder
    $inputChars=New-Object char[] 1024
    while(($readCount=[Console]::In.Read($inputChars,0,$inputChars.Length)) -gt 0){
        if($inputText.Length+$readCount -gt 8192){throw 'input'}
        [void]$inputText.Append($inputChars,0,$readCount)
    }
    $configuration=$inputText.ToString() | ConvertFrom-Json
    if($configuration.schemaVersion -ne 1 -or @($configuration.PSObject.Properties.Name).Count -ne 2 -or $configuration.root -isnot [string]){throw 'input'}
    $observedRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    if(-not [string]::Equals([IO.Path]::GetFullPath($configuration.root).TrimEnd('\'),$observedRoot.TrimEnd('\'),[StringComparison]::OrdinalIgnoreCase)){throw 'root'}
    # Interpret a Windows command line once, at the observation boundary.
    . (Join-Path $PSScriptRoot 'PanelCommandIdentity.ps1')
    $listeners=@(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -in @(41873,41874) } | ForEach-Object {
        [ordered]@{LocalAddress=[string]$_.LocalAddress;LocalPort=[int]$_.LocalPort;OwningProcess=[int]$_.OwningProcess}
    })
    $nodes=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -Property ProcessId,ExecutablePath,CreationDate,CommandLine -ErrorAction Stop)
    if($nodes.Count -gt 256){throw 'capacity'}
    $processes=New-Object Collections.Generic.List[object]
    $ambiguous=New-Object Collections.Generic.List[object]
    $unreadable=0
    foreach($node in $nodes){
        if(-not $node.ExecutablePath -or -not $node.CreationDate -or -not $node.CommandLine){$unreadable++;continue}
        try{$identities=@(Get-PanelCommandIdentity -Root $observedRoot -ExecutablePath ([string]$node.ExecutablePath) -CommandLine ([string]$node.CommandLine))}catch{$unreadable++;continue}
        foreach($identity in $identities){
            if(-not $identity.CommandMatches){$ambiguous.Add([ordered]@{Role=$identity.Role;pid=[int]$node.ProcessId});continue}
            $created=([DateTime]$node.CreationDate).ToUniversalTime().ToString('o')
            $processes.Add([ordered]@{Role=$identity.Role;ProcessId=[int]$node.ProcessId;ExecutablePath=[string]$node.ExecutablePath;CreationDate=$created;CommandLine=[string]$node.CommandLine;CommandMatches=$true})
        }
    }
    $result=[ordered]@{schemaVersion=1;complete=$true;listeners=@($listeners);processes=@($processes.ToArray());ambiguousProcesses=@($ambiguous.ToArray());unreadableNodeProcesses=$unreadable}
    [Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 5 -Compress))
} catch { Write-Unknown }
