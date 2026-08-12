# Structured diagnostic comparison

TS6とTS7のdiagnosticsは、整形済み文字列全体ではなく次のフィールドへ分解して
比較する。

- `code`: `TS2322`などの数値code
- `category`: `error`、`warning`、`suggestion`、`message`
- `file`: repository rootからの相対path。global diagnosticでは`null`
- `line`、`column`: 1-originの位置。global diagnosticでは`null`
- `message`: continuation lineを改行で連結したmessage

結果の`difference.diagnostics`にはTS6だけ、TS7だけに現れた項目をそれぞれ保存する。
`difference.exitCode`はdiagnosticsとは独立して比較する。したがって、diagnosticsが
一致して終了コードだけが違うケースを識別できる。

## Classification

- `SUPPORTED_IDENTICALLY`: diagnosticsと終了コードが両方一致
- `SUPPORTED_WITH_DIFFERENCE`: 観測された差全体が既知差manifestと一致
- `POSSIBLE_REGRESSION`: manifestにない差が1つでもある

既知差は`compatibility/known-diagnostic-differences.json`に、fixture、TS6／TS7の
終了コード、双方にだけ現れるstructured diagnosticの完全な組として記録する。
fixture名だけを根拠に差を既知扱いしないため、同じfixtureへ別のdiagnosticが追加
された場合は`POSSIBLE_REGRESSION`になる。

manifestを更新するときは、差がTypeScript 7の意図された変更だと確認できる根拠と
理由を記録する。単にテストを通すために未知差を登録してはならない。

## Raw output

parserが情報を落とした可能性を後から確認できるように、compilerのstdoutとstderrを
`ts6.rawOutput`と`ts7.rawOutput`へ無加工で保存する。構造化やpath正規化によって
意味のある差が隠れていないかを調べる際は、このraw outputを正本とする。

比較を再実行するコマンドは次のとおり。

```bash
npm run compare
npm run test:diagnostics
```
