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

現在の出力versionは`4.2.0`であり、readerは過去の`1.0.0`、`2.0.0`、`3.0.0`、
`3.1.0`、`4.0.0`、`4.1.0`も検証できる。
version 2では、cold／warmup／measured attempt、失敗状態、timeout、実行順、
mean、母標準偏差、外れ値候補を追加した。成功した計測が0件の場合は、存在しない
統計値を`null`として保存し、`NaN`や`Infinity`をJSONへ書き込まない。
version 3ではattempt単位のCPU timeとpeak RSS、その取得可否、成功したmeasured
attemptだけを対象とするresource statisticsを追加した。未取得値は数値や`null`へ
置き換えず、理由付きの`unavailable`として保存する。
version 3.1ではvariantごとの`applicableFixtures`とscaling metadataを追加した。
これにより、通常projectだけに適用する`--checkers`と、build modeだけに適用する
`--builders`を無効な直積にせず、疎なfixture／variant pairとして保存する。
version 4ではcomparisonのdiagnosticsをcode、category、file、line、column、messageへ
構造化し、diagnostics差と終了コード差を分離した。raw stdout／stderrと既知差の
識別子も保存する。従来の文字列配列から型が変わるためmajor versionを更新し、
readerはversion 1〜3.1のlegacy comparison形式も引き続き検証する。
version 4.1ではcomparisonへcompiler option catalogの実行結果を追加した。entryごとに
classification、migration、reproduction command、期待値、TS6／TS7のstructured
diagnosticsとraw outputを保存する。既存4.0 readerが無視できる追加フィールドのため
minor versionを更新した。
version 4.2ではbenchmarkへ`fixturePreset`を追加し、preset名と全scaleを保存する。
fixture commandにはincremental／watchの測定方式、incremental state、timed invocation
前に消去する出力pathを記録できる。replay環境の`LAB_FIXTURE_PRESET`と
`LAB_FILE_COUNT`はpreset metadataとの整合性を検証する。

`schemaVersion`はSemantic Versioningに準じて更新する。

- MAJOR: 既存readerが解釈できない削除、名称変更、型変更
- MINOR: 既存readerが無視できる任意フィールドや新しい結果種別の追加
- PATCH: 意味や構造を変えない説明、制約、validatorの修正

readerは、対応していないMAJOR versionを拒否する。schemaを変更するときは、
同じPull Requestでschema test、生成スクリプト、reader、ドキュメントを更新する。
過去の測定結果を書き換える場合は、元データを保持し、移行処理を明示する。

結果の保存場所、manifest、latest pointerについては`docs/result-history.md`を
参照する。
