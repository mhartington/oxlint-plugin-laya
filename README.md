# oxlint-plugin-jev

Lint rules written in plain English. [Oxlint](https://oxc.rs/docs/guide/usage/linter.html) finds the code, [TypeSafe Jev](https://typesafe.ai) answers the question.

A rule is one yes/no question about a function, a call, a JSX element, or a whole file. The plugin sends each match to Jev with the question, gets back a probability, and reports an error when it clears your cutoff.

Jev is not a chat model. It only answers questions, and it answers with a number between 0 and 1. That number is what makes a cutoff work.

## Install

```sh
npm i -D oxlint oxlint-plugin-jev
export TYPESAFE_API_KEY="..."   # https://console.typesafe.ai
```

## Config

Add the plugin and its one rule, `jev/ask`, to `.oxlintrc.json`. Your English rules go in the options.

```json
{
  "jsPlugins": ["oxlint-plugin-jev"],
  "rules": {
    "jev/ask": [
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

Every rule has four fields.

| Field      | What it is                                                   |
| ---------- | ------------------------------------------------------------ |
| `id`       | Shown in the error message. Unique in the list.              |
| `target`   | `"function"`, `"call"`, `"jsx"`, or `"file"`.                |
| `question` | A yes/no question. "Yes" means "report this".                |
| `cutoff`   | 0 to 1. Report when Jev's yes-probability is at or above it. |

`target` decides what Jev gets to read.

| Target       | Jev sees                                                                                                     | The error underlines |
| ------------ | ------------------------------------------------------------------------------------------------------------ | -------------------- |
| `"function"` | The whole function. An arrow or method includes its name, so `const getUser = () => ...` reads as `getUser`. | The signature line   |
| `"call"`     | The whole call expression.                                                                                   | The whole call       |
| `"jsx"`      | The whole element, children included.                                                                        | The opening tag      |
| `"file"`     | The whole file.                                                                                              | The first line       |

The wording of the question is the rule, so be precise about what counts. "Does this send personal data" also fires on a legitimate `mailer.send(user.email, ...)`. "To a log or console" does not.

Optional settings, with their defaults.

| Field               | Default        | Meaning                                                                                                                                                                            |
| ------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ci`                | `"skip"`       | What happens when Jev can't be asked and `CI` is set. `"skip"` warns once and reports nothing. `"fail"` fails the run. Outside CI it always skips.                                 |
| `timeoutMs`         | `10000`        | Per-file request timeout, retries included.                                                                                                                                        |
| `maxMatchesPerFile` | `25`           | Snippets sent per file across all rules. Extra matches are dropped in source order.                                                                                                |
| `maxSnippetChars`   | `4000`         | Longer snippets are cut and end with `/* ...truncated */`.                                                                                                                         |
| `model`             | `"jev-latest"` | TypeSafe model id. Pin a versioned id such as `"jev-1.13.0"` in CI once your cutoffs are tuned, so a new build cannot move them. Every diagnostic names the version that answered. |

Oxlint checks the options against a schema before linting anything, so a typo in `target` or an unknown field fails at startup with a clear message.

Two environment variables matter. `TYPESAFE_API_KEY` is required. `TYPESAFE_BASE_URL` overrides the API host and is mostly for tests.

## How it works

One file, one request. Every match in the file goes into a single request body, and Jev answers every question at once. On a small file that is under a second cold.

Answers are cached under `node_modules/.cache/oxlint-plugin-jev`, keyed by exactly what was sent. Change a snippet or a question and that file is re-asked. Tune a cutoff or rename an `id` and nothing is re-asked, because the answers don't depend on either. A cache entry that doesn't parse is treated as a miss, never as a verdict.

Oxlint runs JS rules synchronously, so the rule can't `await`. The request runs on a [`synckit`](https://github.com/un-ts/synckit) worker thread, the same trick `oxlint-plugin-oxfmt` and `eslint-plugin-prettier` use. Inside the worker the official [`@typesafe-ai/sdk`](https://www.npmjs.com/package/@typesafe-ai/sdk) client does the call and retries rate limits and server errors with backoff, all inside `timeoutMs`.

When Jev can't be asked, because the key is missing, the request times out, or the API errors, the plugin prints one warning and reports nothing for that file. Set `ci: "fail"` if you'd rather CI go red than pass without the judgment.

## In the editor

The oxlint VS Code extension lints as you type. Nearly every keystroke changes a snippet, so nearly every keystroke is a paid request that blocks the language server for the round trip. That is a bad time.

Keep `jev/ask` out of the config your editor reads, and put it in an overlay for CI and pre-push. Leave `jsPlugins` in the base config, since the overlay inherits it.

```json
{
  "extends": [".oxlintrc.json"],
  "rules": {
    "jev/ask": ["error", { "rules": [ ... ] }]
  }
}
```

```sh
oxlint                        # editor and local runs, no Jev
oxlint -c .oxlintrc.ci.json   # CI and pre-push, Jev included
```

## Example

`example/` has three rules and two files. `fail.js` gets three errors, `pass.js` gets none. Each rule catches something a pattern-based linter can't express.

| Rule                    | Fails on                                                | Passes on                                   |
| ----------------------- | ------------------------------------------------------- | ------------------------------------------- |
| `no-pii-in-logs`        | `console.log("loaded", user.email, user.phone)`         | `console.log("notified", { userId: id })`   |
| `name-matches-behavior` | `getUser` that also sends an email                      | The same body named `notifySignIn`          |
| `no-prompt-injection`   | A customer message pasted into the system prompt string | The message passed as a separate user field |

```sh
npm run example
```

## Development

TypeScript, built with [Vite+](https://viteplus.dev). ESM only, since oxlint loads plugins with `import()` and that is what the other oxlint plugins ship too.

```sh
npm run build   # src/ to dist/
npm run check   # format, lint, typecheck
npm test        # build, then unit tests and a real oxlint run against a mock Jev
JEV_LIVE=1 TYPESAFE_API_KEY=... npm test   # also runs example/ against the real API
```

Tests that cross the worker thread run against `dist/`, because the worker is resolved next to the built file. That is why `npm test` builds first.

## License

MIT
