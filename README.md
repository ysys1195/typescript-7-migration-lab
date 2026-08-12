# TypeScript 7 Migration Lab

TypeScript 6（JavaScript実装）とTypeScript 7（Goによるネイティブ実装）を、
同じ入力・同じマシンで比較するための実験リポジトリです。

## Project documents

- [実装ロードマップ](docs/roadmap.md)
- [Notion向けポートフォリオ原稿](docs/portfolio-draft.md)
- [測定結果のschema](docs/result-schema.md)
- [測定履歴の保存方式](docs/result-history.md)
- [ベンチマーク手法](docs/benchmark-methodology.md)
- [CPU・メモリ測定方式](docs/resource-measurement.md)
- [checker・builder scaling実験](docs/scaling-experiments.md)
- [diagnosticsの構造化比較](docs/diagnostic-comparison.md)

このラボでは次の問いを扱います。

- コンパイル全体、型チェック、emitはどれくらい速くなったか
- ネイティブ化と並列化は、それぞれどれくらい効いているか
- diagnosticsと生成物はTS6とTS7で一致するか
- TS7で廃止・変更された設定は何か
- 小規模、型負荷、ファイル数、JSX、JSDoc、monorepoで差は変わるか

## Quick start

```bash
npm install
npm run lab:quick
```

通常測定はcold 1回、warm-up 2回、計測10回です。3種類のcompilerは
roundごとに先頭を交代し、特定のcompilerだけが常に先または後にならないように
実行します。

```bash
npm run lab
```

結果は以下に生成されます。

- `results/runs/<run-id>/benchmark.json`: 生の測定値と`--extendedDiagnostics`
- `results/runs/<run-id>/comparison.json`: diagnosticsとemitの比較
- `results/runs/<run-id>/manifest.json`: 2つのartifactを関連付けるmanifest
- `results/latest.json`: 最後に正常完了したrunへの参照
- `results/benchmark.json`、`results/comparison.json`: 互換ミラー
- `reports/latest.md`: 読みやすいサマリー

測定artifactは`schemas/result.schema.json`、manifestとlatest pointerは
`schemas/run-storage.schema.json`で検証されます。

```bash
npm run validate
npm run test:schema
npm run test:store
npm run test:benchmark
npm run test:diagnostics
npm run runs
```

履歴の正本は`results/runs/`です。直下の互換ミラーは最後に正常完了したrunを示す
移行期間中の既存ツール向けで、reportや将来のUIは`latest.json`または明示した
run IDから正本を読み込みます。

## Measuring different sizes

```bash
LAB_FILE_COUNT=1000 LAB_RUNS=20 LAB_WARMUPS=3 npm run lab
```

| 変数 | デフォルト | 意味 |
|---|---:|---|
| `LAB_FILE_COUNT` | 400 | many-files fixtureのファイル数 |
| `LAB_RUNS` | 10 | 各ケースの計測回数 |
| `LAB_WARMUPS` | 2 | 計測前のwarm-up回数 |
| `LAB_FIXTURE_TIMEOUT_MS` | 120000 | compiler実行1回あたりのtimeout（ms） |

## Experiment design

各fixtureを次の3条件で測定します。

1. `tsc6`: TypeScript 6
2. `tsc --singleThreaded`: TypeScript 7の単一スレッド動作
3. `tsc`: TypeScript 7のデフォルト並列動作

TS6とTS7 single-threadedの差からネイティブ実装の効果を、TS7
single-threadedとdefaultの差から並列化の効果を概算できます。ただし、
内部実装が完全に同一ではないため、厳密な因果分解ではありません。

これに加え、`many-files`ではTS7の`--checkers 1/2/4/8`、専用の
`builder-scaling` fixtureでは`--builders 1/2/4`を測定します。builder実験では
checker数を1へ固定し、worker 1を基準に速度とメモリの変化を比較します。

cold値は、そのlab run内で各fixture／variantを最初に起動した値です。OSの
filesystem cacheなどを消去した厳密なcold環境ではありません。coldとwarm-upは
統計から除外し、成功した計測runだけからmedian、p95、mean、母標準偏差を計算
します。Tukeyの1.5×IQRで外れ値候補を表示しますが、測定値からは除外しません。

compiler error、timeout、runner errorはattemptとしてstdout／stderrとともに保存し、
残りのfixtureとvariantの測定を継続します。

diagnostics比較では、各項目をcode、category、file、line、column、messageへ分解し、
終了コードの差とdiagnosticsの差を別々に記録します。既知差は
`compatibility/known-diagnostic-differences.json`との完全一致で判定し、manifestに
ない差は`POSSIBLE_REGRESSION`としてraw stdout／stderrとともに保持します。

CPU timeとpeak RSSは、利用可能な環境ではOSの`/usr/bin/time`で取得します。
取得できない値は0で代用せず、理由付きの`unavailable`として保存します。

| OS | collector | CPU time | peak RSS |
|---|---|---|---|
| macOS | BSD `/usr/bin/time -lp` | 対応 | 対応（bytes） |
| macOS（RSS取得不可時） | BSD `/usr/bin/time -p` | 対応 | `unavailable` |
| Linux | GNU `/usr/bin/time -v` | 対応 | 対応（KiBからbytesへ変換） |
| Windows | — | unavailable | unavailable |

macOSでは`-lp`のprobeでCPU時間だけ取得できた場合、collector
`darwin-time-p`へ切り替えてCPU時間を保持します。macOS／Linuxでもtool、権限、
実行環境の制限によりcollectorのprobeが失敗した場合は
直接実行へ戻り、resource metricsを`unavailable`として記録します。

短い処理ではプロセス起動時間の比率が高くなります。実際のプロジェクトに近い
判断には`many-files`、`type-heavy`、`monorepo`を重視してください。

## Fixtures

- `small`: 起動コストが支配的な小規模プロジェクト
- `type-heavy`: conditional、mapped、template literal types
- `many-files`: 自動生成される多数ファイル
- `jsx`: JSXのパースと型チェック
- `jsdoc`: JavaScript + JSDoc + `checkJs`
- `monorepo`: project referencesとbuild mode
- `builder-scaling`: core後に4つの独立leafをbuildできるbuilder並列度用DAG
- `diagnostics`: 意図的な型エラー
- `emit`: JavaScriptと`.d.ts`の比較
- `legacy-options`: TS7で削除・変更された設定の観察

## Important limitation

TypeScript 7.0には安定したprogrammatic APIがまだありません。このラボは
TS7のCLIを使い、API依存ツールのためにTS6互換パッケージを同居させています。
