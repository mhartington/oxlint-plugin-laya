# oxlint-plugin-laya

> [!WARNING]
> This package is experimental. Use at your own risk.

[Oxlint](https://oxc.rs/docs/guide/usage/linter.html) rules written in plain English, answered by [Laya](https://github.com/NandhaKishorM/laya).

This project is based on [wobsoriano/oxlint-plugin-jev](https://github.com/wobsoriano/oxlint-plugin-jev). It is a proof of concept for swapping the model under the hood from Jev to Laya while keeping the same plain-English linting approach. Credit for the original plugin and idea goes to [wobsoriano](https://github.com/wobsoriano).

A rule is a yes/no question about a function, a call, a JSX element, or a whole file. Each match is sent to Laya with the question, and the plugin reports an error when the yes-probability clears your cutoff.

## Install

```sh
npm i -D oxlint oxlint-plugin-laya
```

Run Laya's HTTP server separately (Python 3.10+):

```sh
python3 -m venv .venv
.venv/bin/python -m pip install 'laya[serve]'
LAYA_HOST=127.0.0.1 LAYA_MODELS=english .venv/bin/laya-serve
```

The plugin defaults to `http://127.0.0.1:8000`, model `english`, with no API key. The server downloads its checkpoint on first startup; wait for it to finish loading before linting.

Set `LAYA_BASE_URL` to use another server (the base URL, without `/v1/systemone`). If the server requires authentication, set `LAYA_API_KEY`; the plugin sends it as a bearer token.

For the [hosted Laya API](https://github.com/NandhaKishorM/laya#hosted-api), set `LAYA_BASE_URL=https://api.impossibl.com`, set `LAYA_API_KEY` to your impossibl API key, and add `"model": "convaiinnovations/laya"` to the rule options alongside `rules` below.

In CI, set `ci: "fail"` so a run that could not reach Laya fails instead of passing quietly.

## Config

Add the plugin and its one rule, `laya/ask`, to `.oxlintrc.json`. Your English rules go in the options.

```json
{
  "jsPlugins": ["oxlint-plugin-laya"],
  "rules": {
    "laya/ask": [
      "error",
      {
        "rules": [
          {
            "id": "no-pii-in-logs",
            "target": "call",
            "question": "Does this call write personal data, such as an email or phone number, to a log or console?",
            "cutoff": 0.8
          },
          {
            "id": "name-matches-behavior",
            "target": "function",
            "question": "Does this function's name imply it only reads data, while its body also writes or sends something?",
            "cutoff": 0.6
          }
        ]
      }
    ]
  }
}
```

| Field      | What it is                                                    |
| ---------- | ------------------------------------------------------------- |
| `id`       | Shown in the error message. Unique in the list.               |
| `target`   | `"function"`, `"call"`, `"jsx"`, or `"file"`.                 |
| `question` | A yes/no question. "Yes" means "report this".                 |
| `cutoff`   | 0 to 1. Report when Laya's yes-probability is at or above it. |

`target` decides what Laya gets to read. There is no selector syntax and no other target.

| Target       | Laya sees                                                                                                    | The error underlines |
| ------------ | ------------------------------------------------------------------------------------------------------------ | -------------------- |
| `"function"` | The whole function. An arrow or method includes its name, so `const getUser = () => ...` reads as `getUser`. | The signature line   |
| `"call"`     | The whole call expression.                                                                                   | The whole call       |
| `"jsx"`      | The whole element, children included.                                                                        | The opening tag      |
| `"file"`     | The whole file.                                                                                              | The first line       |

The wording of the question is the rule, so be precise about what counts. "Does this send personal data" also fires on a legitimate `mailer.send(user.email, ...)`. "To a log or console" does not.

| Setting             | Default     | Meaning                                                                                                                                                                                                      |
| ------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ci`                | `"skip"`    | What happens when Laya can't be asked and `CI` is set. `"skip"` warns once and reports nothing. `"fail"` fails the run. Outside CI it always skips.                                                          |
| `timeoutMs`         | `10000`     | Per-file request timeout, retries included.                                                                                                                                                                  |
| `maxMatchesPerFile` | `25`        | Snippets sent per file across all rules. Extra matches are dropped in source order and the file is named on stderr.                                                                                          |
| `maxSnippetChars`   | `4000`      | Longer snippets are cut and end with `/* ...truncated */`.                                                                                                                                                   |
| `model`             | `"english"` | Local checkpoint: `"english"`, `"multilingual"`, or `"typed-decisions"`. Hosted servers may use other ids, such as `"convaiinnovations/laya"`. Each diagnostic includes the model id returned by the server. |

Tune questions and cutoffs against your own code. Laya's checkpoint context limits also apply to the combined snippets in a request; the local English checkpoint defaults to 512 tokens. Lower `maxMatchesPerFile` and `maxSnippetChars` for short contexts, or configure a server with a larger context. The plugin's character limit does not measure model tokens. The examples illustrate intended rule behavior; actual model decisions may differ.

## How it works

One request per file, with every match in it.

Answers are cached under `node_modules/.cache/oxlint-plugin-laya`, keyed by the request. Changing a snippet or a question re-asks that file. Changing a cutoff or an `id` does not.

The request runs on a worker thread using Node's `fetch`, calling Laya's `POST /v1/systemone` endpoint. Rate limits (429) and server errors (5xx) are retried up to twice within `timeoutMs`, including retry waits and reading response bodies. There is no TypeSafe SDK dependency.

If Laya can't be asked because the server is unavailable, authentication fails, the request times out, or the response is invalid, the plugin prints one warning and reports nothing for that file. Set `ci: "fail"` to fail the run instead.

The cache includes the endpoint, model option, snippets, and questions. Clear `node_modules/.cache/oxlint-plugin-laya` after updating server weights or calibration under the same model id.

## Migrating from Jev

Replace `oxlint-plugin-jev` with `oxlint-plugin-laya` and `jev/ask` with `laya/ask` in your config. Rename `TYPESAFE_BASE_URL` and `TYPESAFE_API_KEY` to `LAYA_BASE_URL` and `LAYA_API_KEY`, using your Laya server URL and credentials. Remove any Jev `model` override or replace it with a Laya model id. The exported types are now `LayaOptions`, `LayaRule`, and `LayaPlugin`.

The `id`, `target`, `question`, and `cutoff` fields are unchanged. Recheck your cutoffs against Laya's answers; Jev cache entries are not reused.

## In the editor

The oxlint VS Code extension lints as you type, and every edit inside a match can trigger inference that blocks the language server until Laya answers.

Keep `laya/ask` out of the config your editor reads, and put it in an overlay for CI and pre-push. Leave `jsPlugins` in the base config, since the overlay inherits it.

```json
{
  "extends": [".oxlintrc.json"],
  "rules": {
    "laya/ask": ["error", { "rules": [ ... ] }]
  }
}
```

```sh
oxlint                        # editor and local runs, no Laya
oxlint -c .oxlintrc.ci.json   # CI and pre-push, Laya included
```

## Example

`example/` has three semantic rules, a file intended to fail all three, and a file intended to pass.

The example selects the hosted model `convaiinnovations/laya`. Set `LAYA_BASE_URL=https://api.impossibl.com` and `LAYA_API_KEY` to your impossibl key before running it. To use the local English checkpoint instead, change `model` in `example/.oxlintrc.json` to `english` and use your local server URL.

| Rule                    | Fails on                                                | Passes on                                   |
| ----------------------- | ------------------------------------------------------- | ------------------------------------------- |
| `no-pii-in-logs`        | `console.log("loaded", user.email, user.phone)`         | `console.log("notified", { userId: id })`   |
| `name-matches-behavior` | `getUser` that also sends an email                      | The same body named `notifySignIn`          |
| `no-prompt-injection`   | A customer message pasted into the system prompt string | The message passed as a separate user field |

```sh
npm run example
```

## Development

TypeScript, built with [Vite+](https://viteplus.dev). ESM only.

```sh
npm run build
npm run check   # format, lint, typecheck
npm test        # builds first, since the worker tests run against dist/
LAYA_LIVE=1 npm test   # also checks example/ against a running local Laya server
```

The default tests use a mock HTTP server and need no Python installation, model downloads, or credentials. The opt-in live test checks the example's intended diagnoses against real model predictions and may require tuning for your checkpoint.

## License

MIT
