# 🐸 Froggy RAG

> Point your app at Froggy. Get RAG automatically.

Froggy RAG is a **local, OpenAI/Ollama-compatible passthrough API** that
injects relevant context from your documents *before* your request hits
the LLM.

No agents.\
No tool wiring.\
No orchestration.

Just:

    Your app → Froggy → LLM (with context already injected)

------------------------------------------------------------------------

# 🚀 Why Froggy?

Most RAG systems make you:

-   wire tools
-   call retrieval APIs
-   manage context manually
-   or adopt a framework

Froggy does this instead:

> **Intercept → Retrieve → Inject → Forward**

Your existing clients don't change.\
They just get smarter.

------------------------------------------------------------------------

# 🧠 What it actually does

When a request comes in:

1.  Understands the request\
2.  Searches your selected namespace\
3.  Pulls the most relevant context\
4.  Optionally adds web search results\
5.  Injects everything into the prompt\
6.  Forwards to your LLM

All automatically.

------------------------------------------------------------------------

# 🧩 Core Concepts

## Namespaces

    rxstream-sql
    walgreens-hub
    personal-notes
    codebase

Each namespace has: - its own documents - its own embeddings - its own
retrieval context

Switch namespace → switch knowledge.

------------------------------------------------------------------------

## Passthrough API

Froggy exposes an **OpenAI-compatible endpoint**.

You send:

``` json
{
  "messages": [
    { "role": "user", "content": "Write a SQL query..." }
  ]
}
```

Froggy enriches and forwards.

------------------------------------------------------------------------

## Prompt Profiles

Reusable behavior templates: - sql-generation\
- sql-modification\
- general-rag

------------------------------------------------------------------------

## Tags & Metadata

``` json
"tags": ["patient", "phi"],
"metadata": { "platform": "databricks" }
```

------------------------------------------------------------------------

# 🖥️ Desktop App

-   Installer-based (Windows)
-   Auto-updates
-   Runs locally
-   Includes UI + API

------------------------------------------------------------------------

# ⚙️ Installation

Download from GitHub releases:
https://github.com/`<your-repo>`{=html}/releases

------------------------------------------------------------------------

# ⚙️ Usage

Start app, then call:

    http://localhost:<froggy port>/<just like Ollama>
    http://localhost:<froggy port>/<just like OpenAI>

------------------------------------------------------------------------

# 🐸 TL;DR

Froggy sits between your app and your LLM and makes every request
smarter.
