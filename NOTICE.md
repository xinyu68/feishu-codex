# Attribution and third-party notices

Feishu Codex is distributed under the [MIT License](LICENSE).

## Codex Channel Bridge

This implementation references the MIT-licensed [Codex Channel Bridge](https://github.com/lsiten/codex-channel-bridge) by **Xuechao Zou**. Its Feishu adapter and Codex app-server integration informed the implementation. The upstream copyright notice and MIT terms are retained in `LICENSE`.

## Codex and Feishu

The group collaboration design was informed by [cc-connect](https://github.com/chenhg5/cc-connect), particularly explicit mentions, quoted messages, and bounded public group context. Feishu Codex implements this flow with its own desktop-linked Codex sessions and local bridge.

Codex integration follows the [official app-server protocol](https://learn.chatgpt.com/docs/app-server), with desktop compatibility verified separately on Windows. Feishu connectivity uses the [official Node.js SDK](https://github.com/larksuite/node-sdk).

Codex and Feishu/Lark names and trademarks belong to their respective owners. This is an independent community project, not an official OpenAI or Feishu product. Users install and authenticate the official Codex app separately; it is not redistributed by this repository.

## Dependencies and artwork

Electron, Node.js, React, the Feishu SDK and other dependencies retain their own licenses. The Windows package includes the Node.js license and the installed production dependencies with their notices; Electron distribution notices are supplied by the packaging toolchain.

The Feishu Codex application icon is project-specific, AI-assisted artwork, included under this project's MIT terms. It is not an official Codex or Feishu logo. Source artwork and its design prompt are in `desktop/assets/`.
