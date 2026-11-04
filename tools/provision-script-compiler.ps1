param([Parameter(Mandatory=$true)][string]$Nupkg,[Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
function Hash-Bytes([byte[]]$Bytes){$algorithm=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant()}finally{$algorithm.Dispose()}}
function Hash-File([string]$File){$algorithm=[Security.Cryptography.SHA256]::Create();$stream=[IO.File]::OpenRead($File);try{return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-','').ToLowerInvariant()}finally{$stream.Dispose();$algorithm.Dispose()}}
function Assert-PlainDirectory([string]$Directory){
 $full=[IO.Path]::GetFullPath($Directory);$volume=[IO.Path]::GetPathRoot($full);$current=$volume
 foreach($part in $full.Substring($volume.Length).Split([IO.Path]::DirectorySeparatorChar,[StringSplitOptions]::RemoveEmptyEntries)){
  $current=[IO.Path]::Combine($current,$part);$item=Get-Item -LiteralPath $current -Force
  if(-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Directory is not plain or contains a reparse point.'}
 }
}
function Read-EntryBytes($Entry,[int64]$Maximum){
 if($null-eq $Entry -or $Entry.Length-lt 1 -or $Entry.Length-gt $Maximum){throw 'Package entry exceeds its fixed byte budget.'}
 $stream=$Entry.Open();$memory=[IO.MemoryStream]::new();try{
  $buffer=New-Object byte[] 65536;$total=0
  while(($count=$stream.Read($buffer,0,$buffer.Length))-gt 0){$total+=$count;if($total-gt $Maximum){throw 'Expanded entry exceeds budget.'};$memory.Write($buffer,0,$count)}
  if($total-ne $Entry.Length){throw 'Package entry length changed.'};return ,$memory.ToArray()
 }finally{$stream.Dispose();$memory.Dispose()}
}
function Write-NewFile([string]$File,[byte[]]$Bytes){
 Assert-PlainDirectory ([IO.Path]::GetDirectoryName($File))
 $stream=[IO.FileStream]::new($File,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{$stream.Write($Bytes,0,$Bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
 Assert-PlainDirectory ([IO.Path]::GetDirectoryName($File))
}
$contractPath=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\manifests\script-compiler-5.0.0.json'))
$contractBytes=[IO.File]::ReadAllBytes($contractPath);if($contractBytes.Length-gt 1048576){throw 'Source contract exceeds budget.'}
$utf8=[Text.UTF8Encoding]::new($false,$true);$contract=($utf8.GetString($contractBytes)|ConvertFrom-Json)
$archivePath=[IO.Path]::GetFullPath($Nupkg);$output=[IO.Path]::GetFullPath($OutputDirectory)
if(-not [IO.Path]::IsPathRooted($Nupkg) -or -not [IO.Path]::IsPathRooted($OutputDirectory) -or $archivePath-ne $Nupkg -or $output-ne $OutputDirectory -or $output-eq [IO.Path]::GetPathRoot($output)){throw 'Explicit canonical absolute package and new output paths are required.'}
if(Test-Path -LiteralPath $output){throw 'Output directory already exists; nothing was overwritten.'}
Assert-PlainDirectory ([IO.Path]::GetDirectoryName($archivePath));Assert-PlainDirectory ([IO.Path]::GetDirectoryName($output))
$packageItem=Get-Item -LiteralPath $archivePath -Force
if($packageItem.PSIsContainer -or ($packageItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $packageItem.Length-lt 1 -or $packageItem.Length-gt $contract.budgets.packageBytes){throw 'Package is not a bounded plain file.'}
if($contract.schemaVersion-ne 1 -or $contract.package.id-ne 'Microsoft.Net.Compilers.Toolset' -or $contract.package.version-ne '5.0.0' -or (Hash-File $archivePath)-ne $contract.package.sha256){throw 'Official package SHA-256 did not match the fixed source contract.'}
$sha512=[Security.Cryptography.SHA512]::Create();$packageStream=[IO.File]::OpenRead($archivePath)
try{if([Convert]::ToBase64String($sha512.ComputeHash($packageStream))-ne $contract.package.sha512){throw 'Official catalog SHA-512 did not match.'}}finally{$packageStream.Dispose();$sha512.Dispose()}
$zip=[IO.Compression.ZipFile]::OpenRead($archivePath)
try{
 $names=New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
 foreach($entry in $zip.Entries){if(-not $names.Add($entry.FullName)){throw 'Duplicate package entry.'}}
 $nuspecBytes=Read-EntryBytes ($zip.GetEntry('Microsoft.Net.Compilers.Toolset.nuspec')) 65536
 $settings=[Xml.XmlReaderSettings]::new();$settings.DtdProcessing=[Xml.DtdProcessing]::Prohibit;$settings.XmlResolver=$null
 $reader=[Xml.XmlReader]::Create([IO.StringReader]::new($utf8.GetString($nuspecBytes).TrimStart([char]0xFEFF)),$settings)
 try{$document=[Xml.XmlDocument]::new();$document.XmlResolver=$null;$document.Load($reader)}finally{$reader.Dispose()}
 $metadata=$document.SelectSingleNode('/*[local-name()="package"]/*[local-name()="metadata"]')
 $id=$metadata.SelectSingleNode('*[local-name()="id"]');$version=$metadata.SelectSingleNode('*[local-name()="version"]');$license=$metadata.SelectSingleNode('*[local-name()="license"]')
 if($id.InnerText-ne $contract.package.id -or $version.InnerText-ne $contract.package.version -or $license.InnerText-ne 'MIT' -or $license.GetAttribute('type')-ne 'expression' -or $metadata.SelectSingleNode('*[local-name()="requireLicenseAcceptance"]').InnerText-ne 'true' -or $metadata.SelectSingleNode('*[local-name()="developmentDependency"]').InnerText-ne 'true'){throw 'Package ID/version/MIT metadata did not match.'}
 $payload=New-Object 'System.Collections.Generic.List[object]';$destinations=New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase);$total=0
 foreach($file in $contract.files){
  if($file.path-notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' -or -not $destinations.Add($file.path) -or $file.path-eq $contract.stampFile){throw 'Unsafe fixed payload path.'}
  if($file.sourceKind-eq 'nuget-entry'){
   if($file.packagePath-notmatch '^(tasks/net472/[^/]+|ThirdPartyNotices\.rtf|Microsoft\.Net\.Compilers\.Toolset\.nuspec)$'){throw 'Unexpected package source path.'}
   $bytes=Read-EntryBytes ($zip.GetEntry($file.packagePath)) $contract.budgets.fileBytes
  }elseif($file.sourceKind-eq 'official-repository-license'){$bytes=$utf8.GetBytes($contract.licenseText)}else{throw 'Unknown fixed payload source.'}
  if($bytes.Length-ne $file.bytes -or (Hash-Bytes $bytes)-ne $file.sha256){throw 'Fixed payload hash/length mismatch.'}
  $total+=$bytes.Length;if($total-gt $contract.budgets.totalBytes -or $payload.Count-ge $contract.budgets.files){throw 'Payload exceeds fixed package budget.'}
  $payload.Add([pscustomobject]@{Path=$file.path;Bytes=$bytes})
 }
 if(Test-Path -LiteralPath $output){throw 'Output directory appeared; nothing was overwritten.'}
 New-Item -ItemType Directory -Path $output -ErrorAction Stop | Out-Null
 Assert-PlainDirectory $output
 foreach($file in $payload){Write-NewFile ([IO.Path]::Combine($output,$file.Path)) $file.Bytes}
 $licenseFile=@($contract.files|Where-Object {$_.sourceKind-eq 'official-repository-license'})[0]
 $stamp=[ordered]@{schemaVersion=1;package=$contract.package;selection=$contract.selection;license=[ordered]@{path=$licenseFile.path;sourceUrl=$licenseFile.sourceUrl;sha256=$licenseFile.sha256;bytes=$licenseFile.bytes;sourceKind=$licenseFile.sourceKind};files=@($contract.files|ForEach-Object {[ordered]@{path=$_.path;sha256=$_.sha256;bytes=$_.bytes}})}
 $stampBytes=$utf8.GetBytes(($stamp|ConvertTo-Json -Depth 8)+[Environment]::NewLine);if($stampBytes.Length-gt $contract.budgets.stampBytes){throw 'Stamp exceeds fixed budget.'}
 Write-NewFile ([IO.Path]::Combine($output,$contract.stampFile)) $stampBytes
 [ordered]@{ok=$true;outputDirectory=$output;id=$contract.package.id;version=$contract.package.version;packageSha256=$contract.package.sha256;files=$payload.Count+1;internalCandidateOnly=$true;systemRuntimeInstalled=$false}|ConvertTo-Json -Depth 4
}finally{$zip.Dispose()}
