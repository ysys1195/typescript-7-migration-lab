# TypeScript 7 Migration Lab

TypeScript 6（JavaScript実装）とTypeScript 7（Goによるネイティブ実装）を、
同じ入力・同じマシンで比較するための実験リポジトリです。

## Project documents

- [実装ロードマップ](docs/roadmap.md)
- [Notion向けポートフォリオ原稿](docs/portfolio-draft.md)
- [測定結果のschema](docs/result-schema.md)
- [測定履歴の保存方式](docs/result-history.md)
- [過去runの比較](docs/historical-comparisons.md)
- [read-only local dashboard](docs/dashboard.md)
- [ecosystem compatibility](docs/ecosystem-compatibility.md)
- [ベンチマーク手法](docs/benchmark-methodology.md)
- [CPU・メモリ測定方式](docs/resource-measurement.md)
- [checker・builder scaling実験](docs/scaling-experiments.md)
- [diagnosticsの構造化比較](docs/diagnostic-comparison.md)
- [compiler option migration catalog](docs/compiler-options.md)
- [性能fixtureとsize preset](docs/performance-fixtures.md)

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
npm run test:options
npm run test:history
npm run test:dashboard
npm run test:ecosystem
npm run runs
```

typescript-eslint、Vite、Vitestの固定バージョンに対するmigration fixtureは次で
再実行できます。registry accessが必要です。

```bash
npm run ecosystem:verify
```

保存済みの最新runと履歴をローカルdashboardで閲覧できます。benchmarkや任意コマンドを
実行する機能はありません。

```bash
npm run dev
```

ブラウザで`http://127.0.0.1:4173`を開きます。画面とread-only APIの詳細は
[dashboard documentation](docs/dashboard.md)を参照してください。

履歴の正本は`results/runs/`です。直下の互換ミラーは最後に正常完了したrunを示す
移行期間中の既存ツール向けで、reportや将来のUIは`latest.json`または明示した
run IDから正本を読み込みます。

任意のcomplete runをbaselineとして、最新runまたは明示したtargetと比較できます。

```bash
npm run compare:runs -- --baseline <run-id>
npm run compare:runs -- --baseline <run-id> --target <run-id> --threshold 5
```

比較結果は`reports/comparisons/`へMarkdown、JSON、CSVで生成されます。machineや
入力条件が異なる場合は数値を表示しつつ、regressionとは断定しません。

## Measuring different sizes

```bash
LAB_FIXTURE_PRESET=large LAB_RUNS=20 LAB_WARMUPS=3 npm run lab
```

| 変数 | デフォルト | 意味 |
|---|---:|---|
| `LAB_FIXTURE_PRESET` | `medium` | 全生成fixtureの`small`／`medium`／`large` preset |
| `LAB_FILE_COUNT` | presetの値 | many-filesだけのファイル数上書き |
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

compiler option catalogは、TS6でdeprecated・TS7でremovedとなる設定と、TS6で
導入されTS7が引き継ぐdefault changeを個別fixtureで検証します。全件または1件を
再実行できます。

```bash
npm run options
npm run options -- --id target-es5
```

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
- `startup-only`: projectを読まないプロセス起動とCLI初期化
- `parse-heavy`: `noCheck`／`noEmit`で構文解析を強調する生成source
- `type-heavy-scaled`: presetで幅と件数を変える合成型計算
- `emit-heavy`: 出力を毎回消して測るJavaScript emit
- `declaration-heavy`: 出力を毎回消して測る`.d.ts` emit
- `module-resolution`: 多数の生成packageとexportsの解決
- `incremental`: 初回、変更なし、1ファイル編集後の独立した測定
- `watch`: 初回build後の編集から次の正常診断まで
- `project-references-dag`: presetで深さと幅を変えるlayered DAG
- `builder-scaling`: core後に4つの独立leafをbuildできるbuilder並列度用DAG
- `diagnostics`: 意図的な型エラー
- `emit`: JavaScriptと`.d.ts`の比較
- `legacy-options`: TS7で削除・変更された設定の観察
- `compiler-options`: optionごとの最小再現fixture

生成fixtureの規模、測定境界、目的と限界は
[性能fixtureとsize preset](docs/performance-fixtures.md)を参照してください。

## Important limitation

TypeScript 7.0には安定したprogrammatic APIがまだありません。このラボは
TS7のCLIを使い、API依存ツールのためにTS6互換パッケージを同居させています。
