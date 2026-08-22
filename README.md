# Kotoha AI

学校で使えることを想定した、安全性重視のAIチャット基盤。

## Architecture

- GitHub Pages: Frontend
- Supabase: Auth / PostgreSQL / RLS / conversations / usage limits
- Cloudflare Workers AI: AI inference
- Web Search: tool-based search integration (planned)

## Security principles

- API secrets are never stored in the frontend repository.
- All user data is protected with Supabase RLS.
- Roles are stored server-side and never trusted from editable user metadata.
- AI requests and usage enforcement will run through a server-side gateway.
- General users use an administrator-approved fixed model.

## Project structure

```text
.
├── index.html
├── login.html
├── chat.html
├── admin.html
├── assets/
├── css/
│   └── style.css
├── js/
│   ├── config.example.js
│   ├── supabase.js
│   ├── auth.js
│   ├── chat.js
│   ├── admin.js
│   └── api.js
└── supabase/
    └── migrations/
```

## Status

Phase 1: Frontend and Supabase foundation.
