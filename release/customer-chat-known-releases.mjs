// Fixed development-side historical byte expectation; not installation or license approval.
// Source: reviewed account-delivery source definition and input manifest, SHA fe161132c2bb63242ca394919121f980f7ef4befd2f354aa91c8f27e607c435f.
// Acceptance/provenance: workbench/validation/20261025-account-delivery/{manifest-refresh,artifact-backcheck,final-consistency}.json.
// The expected BUILD SHA is pinned from that preserved build receipt, never imported from an artifact at runtime.
// Removing a registration makes it unavailable; no automatic discovery, enrollment or publisher-signature claim.
const freeze=value=>{if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;};
export const KNOWN_CUSTOMER_CHAT_RELEASES=freeze([
  {
    "releaseId": "d8a058a4deae284fac909ac41b9d0011d4e2ec5d21630191231f53df8f290712",
    "definition": {
      "component": "buildx-customer-chat-component",
      "stage": "customer-chat-component-only",
      "manifest": "release/customer-chat-component.json",
      "outputBase": "customer-chat",
      "roles": [
        "entry",
        "module",
        "script",
        "style",
        "prompt",
        "document"
      ],
      "exactPaths": [
        "customer-server.mjs",
        "customer-chat.README.zh-CN.md",
        "lib/codex-client-core.mjs",
        "lib/local-runtimes.mjs",
        "lib/panel-server-core.mjs",
        "lib/chat-session.mjs",
        "lib/chat-context.mjs",
        "lib/cad-document-path.mjs",
        "lib/panel-accounts.mjs",
        "lib/codex-confirmation.mjs",
        "lib/customer-chat-profile.mjs",
        "lib/customer-chat.mjs",
        "lib/buildx-runtime-config.mjs",
        "lib/buildx-auth.mjs",
        "lib/panel-audit.mjs",
        "prompts/buildx-customer-chat.zh-CN.md",
        "public/index.html",
        "public/style.css",
        "public/app.js",
        "public/chat-view.mjs",
        "public/account.js",
        "public/codex-account.js"
      ],
      "entryPath": "customer-server.mjs",
      "generatedFiles": {
        "package.json": "{\n  \"name\": \"buildx-customer-chat-candidate\",\n  \"version\": \"0.1.0\",\n  \"private\": true,\n  \"type\": \"module\",\n  \"description\": \"BuildX local customer chat component candidate; not a commercial installer\",\n  \"scripts\": {\n    \"start\": \"node customer-server.mjs\"\n  },\n  \"engines\": {\n    \"node\": \"24.19.0\"\n  },\n  \"os\": [\n    \"win32\"\n  ],\n  \"cpu\": [\n    \"x64\"\n  ],\n  \"buildxCandidate\": {\n    \"component\": \"buildx-customer-chat-component\",\n    \"releaseReady\": false,\n    \"declaredModelAndSourceTools\": 0,\n    \"installer\": false,\n    \"bundledExternalRuntimes\": false\n  }\n}\n"
      }
    },
    "manifestJson": "{\r\n  \"schemaVersion\": 1,\r\n  \"component\": \"buildx-customer-chat-component\",\r\n  \"releaseReady\": false,\r\n  \"entries\": [\r\n    {\r\n      \"path\": \"customer-chat.README.zh-CN.md\",\r\n      \"sha256\": \"a73e06e9572ba8ccb126cb038c8ace704b5f32a820f3332bcaa042c40adda77e\",\r\n      \"byteLength\": 8732,\r\n      \"role\": \"document\",\r\n      \"dependencies\": [],\r\n      \"provenance\": \"BuildX application source\"\r\n    },\r\n    {\r\n      \"path\": \"customer-server.mjs\",\r\n      \"sha256\": \"5733261569a9aea990eac62bf1de023d3af3d5a43857f74ae3317adf860527e7\",\r\n      \"byteLength\": 4990,\r\n      \"role\": \"entry\",\r\n      \"dependencies\": [\r\n        \"lib/customer-chat.mjs\",\r\n        \"lib/panel-audit.mjs\"\r\n      ],\r\n      \"provenance\": \"BuildX application source\"\r\n    },\r\n    {\r\n      \"path\": \"lib/buildx-auth.mjs\",\r\n      \"sha256\": \"7d1831c6fd8f6df75ade40da16c0b74e67e2b49a9a938192ab11d157f8bc2c5c\",\r\n      \"byteLength\": 16219,\r\n      \"role\": \"module\",\r\n      \"dependencies\": [],\r\n      \"provenance\": \"BuildX application source\"\r\n    },\r\n    {\r\n      \"path\": \"lib/buildx-runtime-config.mjs\",\r\n      \"sha256\": \"44d87e51bf0a10202a45c46b1500cc005e386e7d0a33637781da39d632767cfc\",\r\n      \"byteLength\": 1022,\r\n      \"role\": \"module\",\r\n      \"dependencies\": [\r\n        \"lib/buildx-auth.mjs\"\r\n      ],\r\n      \"provenance\": \"BuildX application source\"\r\n    },\r\n    {\r\n      \"path\": \"lib/cad-document-path.mjs\",\r\n      \"sha256\": \"8efa2f77e8a1716aebd1445122abb8ceb82d44c92fb015547ab582e2bb603a92\",\r\n      \"byteLength\": 804,\r\n      \"role\": \"module\",\r\n      \"dependencies\": [],\r\n      \"provenance\": \"BuildX application source\"\r\n    },\r\n    {\r\n      \"path\": \"lib/chat-context.mjs\",\r\n      \"sha256\": \"9fa5002b9fa3fd7617034818effd38eb4ceeabdb8522f5104f044f3048b5d484\",\r\n      \"byteLength\": 4088,\r\n      \"role\": \"module\",\r\n      \"dependencies\": [\r\n        \"lib/cad-document-path.mjs\"\r\n      ],\r\n      \"provenance\": \"BuildX application source\"\r\n    },\r\n    {\r\n      \"path\": \"lib/chat-session.mjs\",\r\n      \"sha256\": \"18c45f0e5790de8287b446dc5cf0ef4ca90ad9fa68df614bd08ed8bf9ee9d8e8\",\r\n      \"byteLength\": 11650,\r\n      \"role\": \"module\",\r\n      \"dependencies\": [],\r\n      \"provenance\": \"BuildX application source\"\r\n    },\r\n    {\r\n      \"path\": \"lib/codex-client-core.mjs\",\r\n      \"sha256\": \"b5b453eec506101f4820cee64a37375c6097067605fb5fd7908790f524d9460c\",\r\n      \"byteLength\": 30614,\r\n      \"role\": \"module\",\r\n      \"dependencies\": [\r\n        \"lib/local-runtimes.mjs\"\r\n      ],\r\n      \"provenance\": \"BuildX application source\"\r\n    },\r\n    {\r\n      \"path\": \"lib/codex-confirmation.mjs\",\r\n      \"sha256\": \"807119c31aa92a13bf4b5dba9214a874a70061724e217bcc9722cc940ca4d34b\",\r\n      \"byteLength\": 9579,\r\n      \"role\": \"module\",\r\n      \"dependencies\": [],\r\n      \"provenance\": \"BuildX application source\"\r\n    },\r\n    {\r\n      \"path\": \"lib/customer-chat-profile.mjs\",\r\n      \"sha256\": \"d47ee30bea3bf36270c801aefa0331ee2d9724a802359565eb516644f1dedeca\",\r\n      \"byteLength\": 3120,\r\n      \"role\": \"module\",\r\n      \"dependencies\": [\r\n        \"prompts/buildx-customer-chat.zh-CN.md\"\r\n      ],\r\n      \"provenance\": \"BuildX application source\"\r\n    },\r\n    {\r\n      \"path\": \"lib/customer-chat.mjs\",\r\n      \"sha256\": \"42510f22202486478004c4ff3d71e83a841159ef727e30bc028ebbd3d4e4d08d\",\r\n      \"byteLength\": 6198,\r\n      \"role\": \"module\",\r\n      \"dependencies\": [\r\n        \"lib/codex-client-core.mjs\",\r\n        \"lib/panel-server-core.mjs\",\r\n        \"lib/customer-chat-profile.mjs\",\r\n        \"lib/buildx-runtime-config.mjs\"\r\n      ],\r\n      \"provenance\": \"BuildX application source\"\r\n    },\r\n    {\r\n      \"path\": \"lib/local-runtimes.mjs\",\r\n      \"sha256\": \"4e86e7111ae19ffe75e6d6b43dba7038f8bc091b2970e919ab9a9b443f4c181e\",\r\n      \"byteLength\": 2283,\r\n      \"role\": \"module\",\r\n      \"dependencies\": [],\r\n      \"provenance\": \"BuildX application source\"\r\n    },\r\n    {\r\n      \"path\": \"lib/panel-accounts.mjs\",\r\n      \"sha256\": \"a1552a0527280facf34bf45831258e32ac8d9f7f0ced3df486d7e952b6d055eb\",\r\n      \"byteLength\": 11381,\r\n      \"role\": \"module\",\r\n      \"dependencies\": [],\r\n      \"provenance\": \"BuildX application source\"\r\n    },\r\n    {\r\n      \"path\": \"lib/panel-audit.mjs\",\r\n      \"sha256\": \"a293e9438f21a36d12543fbe61669ee73bbbfd1bbcaef3e9dba9497f2d3cd825\",\r\n      \"byteLength\": 16063,\r\n      \"role\": \"module\",\r\n      \"dependencies\": [],\r\n      \"provenance\": \"BuildX application source\"\r\n    },\r\n    {\r\n      \"path\": \"lib/panel-server-core.mjs\",\r\n      \"sha256\": \"950df2b130a0c15c24f6dec1a2e36af6bd8269d0df4a83b949ca05569e8cf439\",\r\n      \"byteLength\": 31626,\r\n      \"role\": \"module\",\r\n      \"dependencies\": [\r\n        \"lib/chat-session.mjs\",\r\n        \"lib/chat-context.mjs\",\r\n        \"lib/panel-accounts.mjs\",\r\n        \"lib/codex-confirmation.mjs\",\r\n        \"public/index.html\",\r\n        \"public/style.css\",\r\n        \"public/app.js\",\r\n        \"public/chat-view.mjs\",\r\n        \"public/account.js\",\r\n        \"public/codex-account.js\"\r\n      ],\r\n      \"provenance\": \"BuildX application source\"\r\n    },\r\n    {\r\n      \"path\": \"prompts/buildx-customer-chat.zh-CN.md\",\r\n      \"sha256\": \"ba3524f437a1e4e614b97c3352ab429f972d8d6bc0a4c67c81a4e5a20e4ff7c0\",\r\n      \"byteLength\": 1323,\r\n      \"role\": \"prompt\",\r\n      \"dependencies\": [],\r\n      \"provenance\": \"BuildX application source\"\r\n    },\r\n    {\r\n      \"path\": \"public/account.js\",\r\n      \"sha256\": \"027581954226dec8ba6f2645c5133ba846274ebd36be2bc8ec9033b90d929169\",\r\n      \"byteLength\": 11054,\r\n      \"role\": \"script\",\r\n      \"dependencies\": [],\r\n      \"provenance\": \"BuildX application source\"\r\n    },\r\n    {\r\n      \"path\": \"public/app.js\",\r\n      \"sha256\": \"f04bc5f62eb289c4d8f34430eb5107b2a19fefbc975146c29cbf3499b733a72c\",\r\n      \"byteLength\": 34514,\r\n      \"role\": \"script\",\r\n      \"dependencies\": [\r\n        \"public/chat-view.mjs\"\r\n      ],\r\n      \"provenance\": \"BuildX application source\"\r\n    },\r\n    {\r\n      \"path\": \"public/chat-view.mjs\",\r\n      \"sha256\": \"87893ddb59ef5a69b49c95dd7198dc8e4c2d8aed454cd8b05c1a0abfae213f58\",\r\n      \"byteLength\": 5486,\r\n      \"role\": \"module\",\r\n      \"dependencies\": [],\r\n      \"provenance\": \"BuildX application source\"\r\n    },\r\n    {\r\n      \"path\": \"public/codex-account.js\",\r\n      \"sha256\": \"74eecb20605de7bc5ff61f59332a0fe97d0033cc544f6367abc29b15a673a5e3\",\r\n      \"byteLength\": 11405,\r\n      \"role\": \"script\",\r\n      \"dependencies\": [],\r\n      \"provenance\": \"BuildX application source\"\r\n    },\r\n    {\r\n      \"path\": \"public/index.html\",\r\n      \"sha256\": \"502a0c7854078a9ae3f0a937e3ecb327f75d5da79c344673e0be6e986cf2427b\",\r\n      \"byteLength\": 8453,\r\n      \"role\": \"document\",\r\n      \"dependencies\": [\r\n        \"public/style.css\",\r\n        \"public/app.js\",\r\n        \"public/account.js\",\r\n        \"public/codex-account.js\"\r\n      ],\r\n      \"provenance\": \"BuildX application source\"\r\n    },\r\n    {\r\n      \"path\": \"public/style.css\",\r\n      \"sha256\": \"27cbe7f9e64e2f9314d367ce24558965f76009d8a992eacfc33cd4f70c7b95ce\",\r\n      \"byteLength\": 13478,\r\n      \"role\": \"style\",\r\n      \"dependencies\": [],\r\n      \"provenance\": \"BuildX application source\"\r\n    }\r\n  ]\r\n}\r\n"
  }
]);
