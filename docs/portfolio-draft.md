# TypeScript 7はどこが速いのか — 移行判断まで再現できるMigration Lab

> Notion掲載用の最終原稿。詳細数値と制約は
> [最終技術レポート](final-report.md)を正本とする。

## 3行で説明

TypeScript 6とGoベースのTypeScript 7を、同じinputとcompiler optionsで比較する
実験環境を設計・実装しました。速度、並列化、CPU/RSS、diagnostics、emit、compiler
options、ecosystemを別々の問いとして測定しています。Apple M1の標準runでは、
17 fixtureのTS6対TS7 default速度比の中央値は3.03倍でしたが、他環境へは一般化していません。

## 背景と問題設定

TypeScript 7ではcompilerがJavaScript実装からGoによるnative実装へ移行しました。
「大幅に速くなる」という説明だけでは、実projectの移行判断には情報が足りません。

- 起動、parse、type check、emit、incrementalのどこが速いのか
- native実装とparallel workerの効果をどこまで分けられるか
- wall-clockを短縮するとCPUやmemoryはどう変わるか
- diagnosticsやemitは同じか、差は意図された変更か
- compiler APIを使うtoolも同じタイミングで移行できるか

そこで、性能と互換性を別の実験とし、「どの条件で、どこまで言えるか」を
結果と一緒に保存することにしました。

## 実験設計

### 3条件で速度の内訳を見る

1. TypeScript 6
2. TypeScript 7 `--singleThreaded`
3. TypeScript 7 default

TS6対TS7 single-threadedをnative実装全体の概算、TS7 single-threaded対defaultを
parallel設定の追加効果としました。実装は言語以外も変わるため、厳密な因果分解ではありません。

### ベンチマークの信頼性をデータにする

- cold、warm-up、measuredを分離
- fixtureごとにvariantの先頭を回す`rotating-v1`
- median、p95、mean、母標準偏差、Tukey外れ値候補
- timeout、compiler error、runner errorを失敗データとして保存
- compiler、Node、machine、Git commit、fixture規模、実行順をversioned JSONに保存

グラフやUIを先に作らず、schemaとrun履歴を先に固めました。その結果、CLI、Markdown report、
read-only dashboardが同じ正本データを読む構成にできました。

## 主要な結果

測定条件はApple M1、8 logical CPUs、Node 24.14.0、TS6 6.0.3、TS7 7.0.2、
medium preset、cold 1回、warm-up 2回、計測10回です。

| Fixture | TS6 | TS7 single | TS7 default | 全体速度比 |
|---|---:|---:|---:|---:|
| startup-only | 59.9 ms | 55.3 ms | 53.8 ms | 1.11x |
| parse-heavy | 455.3 ms | 170.9 ms | 134.9 ms | 3.38x |
| type-heavy-scaled | 876.0 ms | 328.0 ms | 289.1 ms | 3.03x |
| emit-heavy | 814.0 ms | 294.8 ms | 268.2 ms | 3.04x |
| incremental-edit | 445.2 ms | 124.6 ms | 116.2 ms | 3.83x |
| project-references-dag | 4502.3 ms | 2085.0 ms | 1272.7 ms | 3.54x |

![TS6からTS7への代表fixture速度比](assets/final-report/performance-speedups.svg)

起動だけは1.11倍で、parse・type・emit・module resolutionは約3倍でした。
つまり、このrunの高速化はprocess起動だけでは説明できません。

17 fixtureの速度比の中央値は、TS6対TS7 singleが2.76倍、TS7 single対defaultが
1.07倍でした。ただしproject-reference DAGではparallelの追加効果が1.64倍あり、
workloadによって並列化の寄与は変わります。

builderを1から4 workersへ増やすと、953.6 msから631.5 msへ1.51倍短縮しましたが、
peak RSSは138.8 MiBから219.7 MiBへ1.58倍増えました。「速い」と「省memory」は
同じ判断ではありません。

## 互換性の結果

- 通常TypeScript、型負荷、JSX、JSDocのdiagnosticsは一致
- 型エラーのdiagnosticsは一致したが、exit codeはTS6=`2`、TS7=`1`
- legacy optionsの差は、非推奨から廃止への既知変更と一致
- JavaScriptと`.d.ts`のemitは一致
- compiler option 12件はすべて固定した期待と一致
- possible regressionは0件

Ecosystemはpackage versionを固定して実行しました。Vite 6.4.3とVitest 4.1.10の
最小経路はTS7-onlyで成功しました。一方、typescript-eslint 8.67.0はTS7-onlyを
peer dependencyとruntime guardで拒否し、compiler API用のTS6とCLI用のTS7を併設すると成功しました。

## 移行にどう使うか

### TS7のpilotを始めやすいproject

- CLIによるtypecheck・buildが中心
- ES2015以上のtargetとmodern module resolutionを使う
- compiler API consumerがないか、TS6併設を許容できる
- diagnostics・emitの固定goldenをCIで照合できる

### 準備が必要なproject

- `target=ES5`、`module=AMD`、`moduleResolution=node10`、`baseUrl`など廃止optionがある
- typescript-eslint等がstable compiler APIを使う
- custom pluginやbuild toolがTypeScript内部APIに依存する
- shared CI runnerの単発performance値だけで移行効果を判定している

実project adapterは、固定commitのcleanなcheckoutをコピーせずに読み取り専用で測定します。
installは手動で、adapterは`--noEmit`と`--build --dry`だけを実行します。合成fixtureの
3倍という数値を自分のprojectに転用せず、自分の環境で測るための出口です。

## 実装した成果物

- TypeScript 6 / 7共存環境と18種類のperformance workload
- cold/warm/measured、回転順、timeout、失敗保存を備えたbenchmark runner
- wall-clock、CPU time、peak RSS、checker/builder scaling
- versioned JSON Schema、run履歴、latest pointer、履歴比較
- diagnosticsの構造化差分、emit比較、compiler option catalog
- typescript-eslint、Vite、Vitestの固定ecosystem fixture
- Ubuntu Node 20/22/24、macOS/Windows Node 24のGitHub Actions CI
- schema済みresultだけを読むlocal read-only dashboard
- origin・commit・cleanlinessを検証するlocal-project adapter
- 再生成できるMarkdown reportとSVG graph

![medium presetの最新runを表示するdashboard](assets/final-report/dashboard-overview.jpg)

## デバッグと品質保証から得た学び

Windows CIの失敗はcompilerの互換性ではなく、resource measurementのtest doubleがUnixの
temporary path構造を前提にしていたことが原因でした。Actions logをjob、test、stack traceの順で
切り分け、Windowsで同じunit testを再現させ、OS非依存のcapability定義へ変えることで
解決しました。修正後は5環境すべてで成功しています。

また、最終runではbenchmark実行中にレポートscriptを編集したため、後段のmetadata照合が
clean/dirtyの不一致を検出して停止しました。これは実験の途中で条件が変わった結果を、
同一runとして公開しないための意図したguardです。作業差分を一時退避して同じcommit・cleanな
条件でcomparisonを再実行し、schema検証後にのみfinalizeしました。

## このプロジェクトで示したいこと

- 技術トピックを、測定可能な仮説へ分解する
- 性能と互換性、速度とmemory、既知差とregressionを混ぜない
- 成功値だけでなく、失敗、exit code、raw evidenceを保存する
- 数値と同じ重さで、machine、input、反復、制約を説明する
- CLI、data model、UI、CI、実project検証を1つの実験契約でつなぐ

「TS7は3倍速い」ではなく、「この条件では3.03倍。ただし、この範囲を超えては
まだ言えない」と説明できることを成果と考えています。

## Links

- [GitHub repository](https://github.com/ysys1195/typescript-7-migration-lab)
- [最終技術レポート](https://github.com/ysys1195/typescript-7-migration-lab/blob/main/docs/final-report.md)
- [実装ロードマップ](https://github.com/ysys1195/typescript-7-migration-lab/blob/main/docs/roadmap.md)
- [GitHub Issues](https://github.com/ysys1195/typescript-7-migration-lab/issues?q=is%3Aissue)

## 今後の課題

- 複数のCPU・OS・固定machineで標準runを反復する
- Vite以外も含む複数のOSS・実projectと合成fixtureの傾向を比較する
- 同一machineでcompiler versionごとの長期履歴を取る
- TS7 programmatic APIと周辺toolの対応を追跡する

詳細な測定条件、resource数値、移行表、再現手順、GitHub Issueへの追跡性は
[最終技術レポート](final-report.md)にまとめています。
