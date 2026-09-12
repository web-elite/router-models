<div align="center">

[🇬🇧 English](README.md) | [🇮🇷 فارسی](README-fa.md)

# 🚀 Router Models

**Use any AI provider — OpenAI, OpenRouter, Groq, Ollama, LM Studio and
more — directly inside VS Code Copilot Chat.**

Bring your own API keys, pick your favorite models, and chat. It's free
and open source.

[![Release](https://img.shields.io/github/v/release/web-elite/router-models?label=Release&logo=github)](https://github.com/web-elite/router-models/releases/latest)
[![VS Code](https://img.shields.io/badge/VS_Code-%3E%3D_1.104-blue?logo=visualstudiocode)](https://code.visualstudio.com/updates/v1_104)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![GitHub Stars](https://img.shields.io/github/stars/web-elite/router-models?style=social&label=%E2%AD%90%20Star%20us%21)](https://github.com/web-elite/router-models/stargazers)

[⬇️ Download](https://github.com/web-elite/router-models/releases/latest) ·
[🪲 Report a Problem](https://github.com/web-elite/router-models/issues)

</div>

> [!IMPORTANT]
> ## ⭐ Please give this project a star!
>
> **Router Models is 100% free.** If it's useful to you, the best way to say
> thanks is a ⭐ **Star** on GitHub — it takes one second and helps other
> people find the project.
>
> ### 👉 <https://github.com/web-elite/router-models> — hit the ★ button!

---

## 🤔 What does it do?

VS Code Copilot Chat normally only offers Microsoft's own models.
**Router Models** lets you add your own AI providers and use **their**
models in the same chat — right from the regular model picker.

**Why you'll love it:**

- 🔑 **Use several API keys together** — got multiple (free) keys? Paste them
  all in. When one hits its limit, the next one takes over automatically.
  No more "rate limit" interruptions.
- ❄️ **No manual waiting** — if a key needs a break, the extension handles
  the timing and switches to another key for you.
- 🏠 **Works with local AI too** — use models running on your own computer
  (Ollama, LM Studio) — no key needed at all.
- 📊 **See what's happening** — a small indicator in the status bar shows
  your keys' status at a glance.
- 🔐 **Your keys stay safe** — they're stored in VS Code's secure storage,
  never in plain text files.
- 🧠 **Works with thinking models** and tool-using agents out of the box.

---

## 📦 How to Install

### Option 1 — From the VS Code Marketplace *(easiest)*

1. Open VS Code
2. Click the **Extensions** icon on the left sidebar (or press `Ctrl+Shift+X`)
3. Search for **Router Models**
4. Click **Install**

Or open this link in your browser and click Install:
**<https://marketplace.visualstudio.com/items?itemName=web-elite.router-models>**

### Option 2 — Download the file from GitHub

1. Go to the
   **[Releases page](https://github.com/web-elite/router-models/releases/latest)**
   and download the file ending in **`.vsix`**
2. Open VS Code → click the **Extensions** icon (`Ctrl+Shift+X`)
3. Click the **⋯ menu** (top of the Extensions panel) → **Install from VSIX…**
4. Choose the file you downloaded — done!

> [!TIP]
> With Option 2, VS Code won't update the extension automatically. To get
> notified about new versions, click **Watch → Custom → Releases** on the
> GitHub page.

---

## 🚀 How to Use

1. Press `Ctrl+Shift+P` and type **Router Models: Add Provider**
2. Fill in the simple form:
   - **Name** — anything you like, e.g. `My OpenAI`
   - **Base URL** — the provider's address (see the table below)
   - **API keys** — one or more, each on a new line
     *(skip this for local Ollama / LM Studio)*
3. Open Copilot Chat, click the **model picker** at the top — your new
   models are there under **Router Models**. Pick one and chat! 🎉

You can also manage everything from the **Router Models panel** in the
left activity bar — add, edit or remove providers with simple buttons.

### 🌐 Ready-to-copy Base URLs

| Provider | Base URL |
| --- | --- |
| OpenAI | `https://api.openai.com/v1` |
| OpenRouter | `https://openrouter.ai/api/v1` |
| Groq | `https://api.groq.com/openai/v1` |
| Together AI | `https://api.together.xyz/v1` |
| Ollama *(on your PC)* | `http://localhost:11434/v1` |
| LM Studio *(on your PC)* | `http://localhost:1234/v1` |

Any other service that works with the "OpenAI format" will work too.

---

## 🏷️ Mark models as free

Every model in the **Router Models** panel has a small **+ free** button.
Click it to tag the model as free:

- the sidebar shows a green **✓ free** badge next to the model,
- in the Copilot model picker the model is listed as `Model name (free)`,
  so typing **free** in the picker's search box lists all your free models
  across every provider,
- models whose id or name already contains "free" (like OpenRouter's
  `:free` models) get the label automatically,
- the flag is kept when you refresh the provider's model list.

To remove the label, click the button again. The **+ Model** form and the
`Router Models: Add Model Manually` command ask about the free tag too.

---

## 📥 Import from a backup file (9router, omnirouter or any fork of 9router)

1. Run **`Router Models: Import Providers from JSON`** — or click the ⇩
   button in the sidebar.
2. Pick your `.json` backup file.
3. That's it! All providers and API keys in the file are added
   automatically — keys you already have are skipped, so nothing gets
   duplicated. The model list fills in by itself.

---

## ❓ Common Questions

<details>
<summary><b>Where are my API keys stored?</b></summary>
<br>

In VS Code's built-in secure storage — the same place VS Code keeps its own
secrets. They never appear in your settings or project files.
</details>

<details>
<summary><b>I don't see my models in the chat picker</b></summary>
<br>

Click the status bar item (bottom left, starting with "Router") and choose
**Refresh**, or run `Router Models: Refresh Models` from the command
palette. Also make sure your VS Code is up to date (1.104 or newer).
</details>

<details>
<summary><b>Do local providers like Ollama need a key?</b></summary>
<br>

No — just leave the key field empty.
</details>

<details>
<summary><b>One of my keys stopped working</b></summary>
<br>

The extension marks broken keys automatically and stops using them. Open
the status bar menu to see each key's status, or edit the provider to
replace a key. You can also clear cooldowns with one click.
</details>

---

## 🤝 Contribute

Found a bug or have an idea?
[Open an issue](https://github.com/web-elite/router-models/issues) —
all kinds of contributions are welcome!

---

## ⭐ Support the Project

> [!TIP]
> **If Router Models saves you time or money, please give it a ⭐ Star!**
>
> Stars keep the project alive and help other developers discover it.
>
> **👉 [github.com/web-elite/router-models](https://github.com/web-elite/router-models)**

Other ways to help:

- 🪲 [Report bugs](https://github.com/web-elite/router-models/issues)
- 💡 Suggest ideas for new features
- 📣 Tell your friends and colleagues about it

---

## 📄 License

[MIT](LICENSE) © Web Elite

---

<div align="center">

**Made with ❤️ by [Web Elite](https://github.com/web-elite)**

If this extension is useful to you, please consider giving it a ⭐ Star on
GitHub — [it really helps!](https://github.com/web-elite/router-models/stargazers)

</div>
