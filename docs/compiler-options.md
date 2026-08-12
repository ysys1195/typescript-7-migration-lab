# TypeScript 6-to-7 compiler option catalog

catalogの正本は`compatibility/compiler-options.json`であり、各entryに分類、fixture、
TS7向けmigration、公式の意図を示すsource、再現command、固定compiler versionでの
期待結果を保存する。

## Classification semantics

- `DEPRECATED_IN_TS6`: TS6はoptionを認識するがdeprecation diagnosticを返す
- `REMOVED_IN_TS7`: TS7は同じoptionをhard errorとして拒否する
- `DEFAULT_CHANGED`: TS6で導入され、TS7が採用している新しいdefault

`DEFAULT_CHANGED`はTS6とTS7の差ではない。TS5以前からTS7へ移行するときに影響する
設定として、TS6／TS7の両方が同じ新defaultを観測するfixtureを保存する。

## Covered options

| Option | Classification | TS7 migration |
|---|---|---|
| `target=ES5` | deprecated → removed | ES2015以上を使用。旧runtime向けemitは別transpilerへ分離 |
| `module=AMD` | deprecated → removed | ESNext／Preserveとbundlerを使用 |
| `moduleResolution=node10` | deprecated → removed | BundlerまたはNodeNextを使用 |
| `baseUrl` | deprecated → removed | `baseUrl`を削除し、`paths`をproject root相対へ変更 |
| `downlevelIteration` | deprecated → removed | optionを削除しES2015以上をtargetにする |
| `esModuleInterop=false` | deprecated → removed | false設定を削除し、必要ならimportを更新 |
| `strict` default | default changed | errorを修正するか移行中のみ明示的にfalse |
| `module` default | default changed | runtime／bundler要件に合わせて明示 |
| `target` default | default changed | runtime要件を固定するため明示 |
| `noUncheckedSideEffectImports` default | default changed | path修正またはasset用ambient moduleを追加 |
| `rootDir` default | default changed | 従来のoutput layoutが必要なら`./src`などを明示 |
| `types` default | default changed | `node`、`jest`など必要なglobal packageだけを明示 |

## Reproduction and regression handling

```bash
npm run options
npm run options -- --id root-dir-default
```

probeはexit code、structured diagnostic code、必要な場合はtemporary directoryにemit
された相対pathを期待値と照合する。一致すれば`MATCHED_EXPECTATION`、違えば
`POSSIBLE_REGRESSION`となりcommandも失敗する。fixture名だけで既知変更扱いには
しない。raw stdout／stderrは`comparison.json`に保存する。

公式の意図はcatalog内の`source`で追跡する。現在のdefault changesはTS6で導入され、
TS7が採用している。removed optionsはTS6 deprecationをTS7がhard error化したもの。
