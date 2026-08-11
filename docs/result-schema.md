# Result schema

測定結果と互換性比較は、`schemas/result.schema.json`で定義されたJSON Schemaに
従う。

## Envelope

`results/runs/<run-id>/benchmark.json`と
`results/runs/<run-id>/comparison.json`は、次の共通情報を持つ。

- `schemaVersion`: 結果形式のバージョン
- `kind`: `benchmark`または`comparison`
- `runId`: 1回のlab実行を識別するUUID
- `generatedAt`: 結果の生成日時
- `metadata.compilers`: TS6とTS7のバージョンと実行ファイル
- `metadata.runtime`: Node.js、OS、architecture
- `metadata.hardware`: CPU、logical CPU数、総メモリ
- `metadata.git`: commit、branch、working treeの状態
- `configuration`: fixture、引数、warm-up、計測回数などの入力条件

`npm run lab`では、benchmarkとcomparisonに同じ`runId`を渡す。各スクリプトを
個別に実行した場合は、それぞれ独立した`runId`になる。

## Validation

結果は書き込み前と読み込み時に検証される。既存ファイルだけを検証する場合は
次を実行する。

```bash
npm run validate
```

schema自体のテストは次で実行する。

```bash
npm run test:schema
```

不正な結果を自動修正したり無視したりせず、schema validation errorとして扱う。

## Compatibility policy

現在の出力versionは`3.0.0`であり、readerは過去の`1.0.0`と`2.0.0`も検証できる。
version 2では、cold／warmup／measured attempt、失敗状態、timeout、実行順、
mean、母標準偏差、外れ値候補を追加した。成功した計測が0件の場合は、存在しない
統計値を`null`として保存し、`NaN`や`Infinity`をJSONへ書き込まない。
version 3ではattempt単位のCPU timeとpeak RSS、その取得可否、成功したmeasured
attemptだけを対象とするresource statisticsを追加した。未取得値は数値や`null`へ
置き換えず、理由付きの`unavailable`として保存する。

`schemaVersion`はSemantic Versioningに準じて更新する。

- MAJOR: 既存readerが解釈できない削除、名称変更、型変更
- MINOR: 既存readerが無視できる任意フィールドや新しい結果種別の追加
- PATCH: 意味や構造を変えない説明、制約、validatorの修正

readerは、対応していないMAJOR versionを拒否する。schemaを変更するときは、
同じPull Requestでschema test、生成スクリプト、reader、ドキュメントを更新する。
過去の測定結果を書き換える場合は、元データを保持し、移行処理を明示する。

結果の保存場所、manifest、latest pointerについては`docs/result-history.md`を
参照する。
