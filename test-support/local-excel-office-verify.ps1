[CmdletBinding()]
param(
    [Parameter(Mandatory)][string] $WorkbookPath,
    [string] $SheetName,
    [string] $ExpectedModel = 'BX-150-80',
    [double] $ExpectedQuantity = 2,
    [double] $ExpectedUnitPrice = 12500,
    [double] $ExpectedTotal = 25000,
    [string] $ExpectedAmountFormula = '=B2*C2',
    [string] $ExpectedTotalFormula = '=SUM(D2:D2)'
)

$ErrorActionPreference = 'Stop'

$resolved = (Resolve-Path -LiteralPath $WorkbookPath).ProviderPath
$item = Get-Item -LiteralPath $resolved
if ($item.PSIsContainer -or $item.Extension -ne '.xlsx' -or
    ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'Expected an ordinary generated XLSX test file.'
}
$hashBefore = (Get-FileHash -LiteralPath $resolved -Algorithm SHA256).Hash
$preexisting = @(Get-Process -Name EXCEL -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)

if (-not ('BuildXVerification.ExcelProcess' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace BuildXVerification {
    public static class ExcelProcess {
        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

        public static int FromWindow(IntPtr window) {
            uint processId;
            GetWindowThreadProcessId(window, out processId);
            return checked((int) processId);
        }
    }
}
'@
}

$office = $null
$ownedProcess = $null
$books = $null
$book = $null
$sheets = $null
$sheet = $null
$cells = $null
$amount = $null
$total = $null
$result = $null

try {
    $office = New-Object -ComObject Excel.Application
    $officeProcessId = [BuildXVerification.ExcelProcess]::FromWindow([IntPtr] $office.Hwnd)
    if ($officeProcessId -le 0 -or $officeProcessId -in $preexisting) {
        throw 'Could not verify ownership of a new Excel instance.'
    }
    $process = Get-Process -Id $officeProcessId
    if ($process.ProcessName -ne 'EXCEL') {
        throw 'The new COM instance did not resolve to Excel.'
    }
    $ownedProcess = $process
    $office.Visible = $false
    $office.DisplayAlerts = $false
    $office.EnableEvents = $false
    $office.AutomationSecurity = 3

    $books = $office.Workbooks
    if ($books.Count -ne 0) { throw 'Excel started with an unexpected open workbook.' }

    # Disable update of external links, open read-only, and do not add this file to Recent.
    $book = $books.Open($resolved, 0, $true, 5, '', '', $true, 2, '',
        $false, $false, 0, $false, $false, 0)
    if ($books.Count -ne 1 -or -not $book.ReadOnly) {
        throw 'Expected a single read-only verification workbook.'
    }

    $sheets = $book.Worksheets
    $sheet = if ($SheetName) { $sheets.Item($SheetName) } else { $sheets.Item(1) }
    $cells = $sheet.Range('A2:C2')
    $amount = $sheet.Range('D2')
    $total = $sheet.Range('D3')

    $office.CalculateFullRebuild()
    if ($office.CalculationState -ne 0) { throw 'Excel did not finish calculation.' }
    $data = $cells.Value2
    $modelValue = $data.GetValue(1, 1)
    $quantityValue = $data.GetValue(1, 2)
    $priceValue = $data.GetValue(1, 3)
    $amountValue = $amount.Value2
    $totalValue = $total.Value2
    $amountFormula = [string] $amount.Formula
    $totalFormula = [string] $total.Formula

    if ($modelValue -cne $ExpectedModel -or $quantityValue -isnot [double] -or
        $quantityValue -ne $ExpectedQuantity -or $priceValue -isnot [double] -or
        $priceValue -ne $ExpectedUnitPrice -or $amountValue -isnot [double] -or
        $amountValue -ne $ExpectedTotal -or $totalValue -isnot [double] -or
        $totalValue -ne $ExpectedTotal -or $amountFormula -cne $ExpectedAmountFormula -or
        $totalFormula -cne $ExpectedTotalFormula) {
        throw 'Excel did not confirm the expected quote values and formulas.'
    }

    $result = [ordered]@{
        verified = $true
        officeVersion = [string] $office.Version
        officeBuild = [string] $office.Build
        model = $modelValue
        quantity = $quantityValue
        unitPrice = $priceValue
        amount = $amountValue
        grandTotal = $totalValue
        amountFormula = $amountFormula
        totalFormula = $totalFormula
    }
}
finally {
    try {
        if ($book -and $ownedProcess) { $book.Close($false) }
    }
    finally {
        try {
            if ($ownedProcess -and ($null -eq $books -or $books.Count -eq 0)) { $office.Quit() }
        }
        finally {
            foreach ($reference in @($total, $amount, $cells, $sheet, $sheets, $book, $books, $office)) {
                if ($null -ne $reference -and [Runtime.InteropServices.Marshal]::IsComObject($reference)) {
                    [void] [Runtime.InteropServices.Marshal]::FinalReleaseComObject($reference)
                }
            }
        }
    }
}

if (-not $ownedProcess.WaitForExit(10000)) { throw 'The independent Excel process did not exit.' }
$hashAfter = (Get-FileHash -LiteralPath $resolved -Algorithm SHA256).Hash
if ($hashAfter -ne $hashBefore) { throw 'Excel unexpectedly changed the verification workbook.' }
$result.workbookSha256 = $hashAfter.ToLowerInvariant()
$result.excelProcessExited = $true
$result | ConvertTo-Json -Compress
