# BuildX

[简体中文](README.md) · English

BuildX is an AI workspace for Autodesk Revit. Use your own Codex from the Revit sidebar to ask questions about the active model, reference project documents, or review and approve supported model changes. A local Revit add-in performs model operations through the native Revit API.

## What you can do

- **Chat with project context**. Connect to your existing Codex installation and select project documents, attachments, or Skills for the current turn.
- **Query models and find commands**. Inspect the active document, selection, and element parameters. Search built-in commands and personal commands already loaded, and mark commands as favorites for the current session.
- **Approve supported model changes**. The confirmed-write candidate supports specified instance and type parameter edits and model group creation. BuildX checks the active document and project access, then asks for approval in BuildX and Revit for each operation. Use rollback preview to inspect changes. If a request times out and the outcome is unknown, look up its original receipt to avoid duplicate execution.
- **Generate a pump family in the candidate**. Review the dimensions, port sizes, and destination in chat to request a standalone horizontal end-suction pump `.rfa` with inlet and outlet connectors. An internal candidate has loaded in Revit 2024. The implementation status tracks live testing of the embedded WebView and the generate, save, and reopen flow.
- **Try optional chat tools in an isolated preview**. The preview offers local OCR for scanned PDFs, approved Excel generation, and live web search and image generation through Codex. See the setup, dependencies, and verification scope in the [chat tools preview record](docs/migration/CHAT-LOCAL-TOOLS-20261115.zh-CN.md).

BuildX is in internal testing and candidate packages carry `releaseReady:false`. Current integration testing focuses on Windows x64 and Revit 2024. An earlier dual-version candidate covered Revit 2025 build `25.0.2.419`. Check the build and validation records for the candidate you use. [Implementation status](docs/migration/STATUS.md) · [Dual-version installation record](docs/migration/CONFIRMED-WRITE-DUAL-20261108.zh-CN.md)

## Install and get started

1. Obtain an internal candidate that matches your Revit version. The machine needs WebView2 Evergreen Runtime x64, Node.js x64 22.17 or newer, Python 3.11 or newer with `pypdf`, and a working `codex.exe` signed in to your account.
2. Save your work and exit the corresponding Revit version. Extract the entire candidate and run `BuildX-Setup.cmd`. Select the Revit target, existing runtimes, an installation directory, and a separate data directory, then review the installation plan. Before updating an existing installation, check and back up its add-in manifest and preserve its data. [Installation and rollback](docs/migration/CONFIRMED-WRITE-DUAL-20261108.zh-CN.md)
3. Start the matching Revit version and open the sidebar from **BuildX** on the ribbon. Connect Codex and try a read-only query in a test model. To apply a change, set the project access scope and verify the document, target, and operation before confirming.

If Codex detection finds more than one possible runtime, select the absolute path to your existing `codex.exe` in the installer. When running from source, set `BUILDX_CODEX_EXE` to the absolute path. [Codex runtime selection](docs/migration/LOCAL-RUNTIME-SELECTION-20261114.zh-CN.md)

## Develop from source

In the repository root on Windows, install the locked dependencies and run the entry-point syntax check and targeted test suites. Some tests use the installed .NET Framework C# compiler to run controlled Revit host fixtures.

```powershell
npm ci --ignore-scripts
npm run check
npm run test:native-queries
npm run test:layout
```

To build a Revit 2024 confirmed-write candidate, point the build at the installed Revit 2024 API, the restored official WebView2 NuGet SDK `1.0.2478.35` directory, and a new output directory. Replace the example paths with paths on your machine. You can build and package the candidate without registering the add-in. [Installer and packaging guide](tools/buildx-setup-readme.md)

```powershell
New-Item -ItemType Directory -Force '.\artifacts' | Out-Null
.\revit-addin\build.ps1 -IsolatedBuild -ConfirmedWrite `
  -RevitDirectory 'C:\Program Files\Autodesk\Revit 2024' `
  -WebView2PackageDirectory 'C:\path\to\microsoft.web.webview2\1.0.2478.35' `
  -OutputDirectory '.\artifacts\buildx-revit2024'

node tools/buildx-installer.mjs --build-confirmed-write-candidate `
  '.\artifacts\buildx-candidate' '.\artifacts\buildx-revit2024' '0.8.9-local-test'
```

## Repository guide

| Location | Purpose |
| --- | --- |
| [`revit-addin/`](revit-addin/) · [`family-core/`](family-core/) | Revit add-in, native commands, and family tools |
| [`server.mjs`](server.mjs) · [`lib/`](lib/) · [`public/`](public/) | Local service, Codex connection, access controls and receipts, and web UI |
| [`tools/buildx-installer.mjs`](tools/buildx-installer.mjs) · [`buildx-installation.example.json`](buildx-installation.example.json) | Installer entry point and configuration template |

- [Version history](CHANGELOG.md) · [Implementation status](docs/migration/STATUS.md) · [Task ledger](docs/migration/TASKS.json)
- [Runtime layout](docs/migration/RUNTIME-LAYOUT.zh-CN.md) · [Native migration plan](docs/migration/NATIVE-DEPENDENCY-REPLACEMENT.zh-CN.md)
- [Third-party notices](THIRD-PARTY-NOTICES.md)
