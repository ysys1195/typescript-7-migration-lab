# Result history

## 保存構造

測定履歴の正本は`results/runs/<run-id>/`である。

```text
results/
├── runs/
│   └── <run-id>/
│       ├── benchmark.json
│       ├── comparison.json
│       └── manifest.json
├── latest.json
├── benchmark.json
└── comparison.json

reports/
└── comparisons/
    └── <baseline-run-id>--<target-run-id>/
        ├── comparison.json
        ├── comparison.md
        └── comparison.csv
```

`manifest.json`は、同じ`runId`のbenchmarkとcomparisonを関連付ける。
`latest.json`は、最後に正常完了したrunのmanifestを指すJSON pointerである。
symlinkを使わないため、Windowsを含む環境で同じ形式を利用できる。

直下の`benchmark.json`と`comparison.json`は既存の利用方法を維持するための
互換ミラーであり、最後にfinalizeされたrunだけを反映する。履歴の正本ではない。
新しいreaderはrun directoryまたは`latest.json`を利用すること。

## Run lifecycle

1. `benchmark.json`または`comparison.json`の保存時にpartial manifestを作る。
2. 両artifactをJSON Schemaで検証する。
3. `runId`、`kind`、`schemaVersion`、metadataの整合性を確認する。
4. manifestを`complete`へ変更する。
5. 互換ミラーを更新する。
6. 最後に`latest.json`を更新する。

収集中に失敗したrunは`partial`として残るが、latestにはならない。artifact保存直後に
中断しても、同じ内容で再実行すればmanifestを回復できる。finalizeの公開処理中に
失敗したrunは`complete`のままlatestにならない場合があるが、finalizeの再実行で
互換ミラーとlatest pointerを回復できる。artifact、manifest、latest pointerは
一時ファイルへ書き込んだ後、同一directory内でrenameする。

finalize済みrunへのartifact上書きは禁止する。`finalize`自体は再実行可能とし、
manifest完了後に互換ミラーやlatest更新で中断した場合に回復できるようにする。
互換ミラー2ファイルのペア単位の原子性は保証しない。同一runのペアが必要なreaderは、
正本であるmanifestとrun directoryを参照する。

## Commands

通常は一括実行を利用する。

```bash
npm run lab
```

最新のcomplete runを検証・レポート生成する。

```bash
npm run validate
npm run report
```

特定runを対象にする場合は`--run-id`を指定する。

```bash
npm run validate -- --run-id <run-id>
npm run report -- --run-id <run-id>
```

履歴一覧は次で確認する。partialや不正なdirectoryも既定で表示する。

```bash
npm run runs
npm run runs -- --complete-only
```

任意の2つのcomplete runを比較する。`--target`を省略した場合はlatest runを使う。

```bash
npm run compare:runs -- --baseline <run-id>
npm run compare:runs -- --baseline <run-id> --target <run-id> --threshold 5
```

比較方法、machine fingerprint、判定の意味は
`docs/historical-comparisons.md`を参照する。

## Git policy

測定結果にはマシン情報やGit metadataが含まれ、規模によっては大容量になるため、
`results/`配下の生成物はGit管理しない。`results/.gitkeep`だけを追跡する。

比較summaryを共有する場合は必要な生成物だけを明示的に扱い、ローカルの全履歴を
そのままcommitしない。
