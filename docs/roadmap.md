# TypeScript 7 Migration Lab — Implementation Roadmap

## 1. このプロジェクトの目的

TypeScript 7は、TypeScript自身で実装されJavaScriptとして実行されていた従来の
コンパイラから、Goによるネイティブ実装へ移行した。

このリポジトリでは、公開されている性能値を紹介するだけではなく、同一環境・
同一入力でTypeScript 6とTypeScript 7を実行し、次の問いに再現可能な実験で
答えることを目指す。

1. どの処理が、どの程度高速化したのか
2. ネイティブ化と並列化は、それぞれどの程度寄与しているのか
3. メモリ使用量や開発時の待ち時間はどう変わったのか
4. TypeScript 6とTypeScript 7で診断・生成物は一致するのか
5. TypeScript 7で削除、変更、追加された機能は何か
6. compiler APIや周辺ツールを含め、移行できないケースは何か

## 2. 設計原則

### 再現可能であること

測定コマンド、fixture、コンパイラのバージョン、マシン情報を記録し、第三者が
同じ実験を再実行できる状態にする。

### 性能と互換性を分けて扱うこと

「速い」と「同じように動く」は別の問題である。性能、diagnostics、emit、
設定、programmatic API、エディタ体験を別々に検証する。

### 意図された変更とregressionを区別すること

単純な文字列差分だけで互換性を判断しない。公式に意図された変更、終了コード
のみの変更、未対応機能、未知の差を分類する。

### 小さなfixtureだけで結論を出さないこと

短い処理はプロセス起動時間に支配される。ファイル数、型計算量、project
referencesの構造を変え、規模による傾向を見る。

### UIより先にデータ契約を固定すること

測定結果のschemaと比較ロジックを先に安定させ、UIが測定スクリプトの内部実装へ
依存しないようにする。

## 3. 現在の状態

MVPでは以下を実装済み。

- TypeScript 6とTypeScript 7の同居
- TS6、TS7 single-threaded、TS7 defaultの反復測定
- small、type-heavy、many-files、JSX、JSDoc、monorepo fixture
- startup、parse、type-check、emit、module resolution、incremental、watch、
  project-reference DAGを分離する性能fixtureとsmall／medium／large preset
- diagnostics比較
- JavaScriptと`.d.ts`のemit比較
- legacy compiler optionsの差分確認
- JSON結果とMarkdownレポートの生成
- `npm run lab`による一括実行

初回quick runでは、Apple M1環境の小規模fixtureにおいてTS7がTS6より
約2.6〜2.9倍高速だった。ただし、これはプロセス起動時間の比率が大きい
小規模実験の値であり、大規模プロジェクトに一般化できる結論ではない。

また、意図的な型エラーのdiagnostics本文は一致したが、プロセス終了コードは
TS6が`2`、TS7が`1`だった。emit fixtureのJavaScriptと`.d.ts`は一致した。

## 4. 実装フェーズ

### Phase 1 — 測定結果のschemaと実行メタデータ

目的は、今後fixtureやUIを増やしても壊れないデータ契約を定義すること。

実装内容：

- 結果JSONに`schemaVersion`と`runId`を追加
- TS6、TS7、Node.jsのバージョンを保存
- OS、architecture、CPU、logical CPU数、総メモリを保存
- Git commitとworking treeの状態を保存
- fixtureごとにコマンド、設定、規模を保存
- 成功、compiler error、runner errorを区別
- JSON Schemaによる出力検証
- `results/runs/<run-id>/`への履歴保存
- `results/latest.json`による最新runの参照

完了条件：

- 過去と現在のrunを同じプログラムで読み込める
- 不正な結果JSONを検出できる
- 測定値だけを見て実行環境と入力条件を復元できる

### Phase 2 — ベンチマークの信頼性向上

目的は、偶然の速い／遅いrunに左右されない測定を行うこと。

実装内容：

- cold runとwarm runの分離
- 実行順序のランダム化または交互実行
- process起動時間だけを測るbaseline
- median、p95、平均、標準偏差
- 外れ値候補の表示
- wall-clock time、CPU time、peak RSS
- 失敗したfixtureがあっても測定を継続
- timeout
- `--checkers 1/2/4/8`のmatrix
- `--builders 1/2/4`のmatrix
- 同じ条件を再実行するコマンド

完了条件：

- 連続したrunのばらつきを数値で説明できる
- TS7 single-threadedとdefaultの差を比較できる
- fixture単位の失敗が全測定を失敗させない

### Phase 3 — 性能fixtureの拡充

目的は、どの処理で速度差が生まれるかを分離すること。

追加するfixture：

- `startup-only`: プロセス起動コスト
- `parse-heavy`: 大量の構文解析
- `type-heavy-scaled`: 型計算の深さと幅を変更
- `emit-heavy`: JavaScript emit
- `declaration-heavy`: `.d.ts` emit
- `module-resolution`: 大量importとpackage解決
- `incremental`: 初回、変更なし、1ファイル変更
- `watch`: 編集から再診断まで
- `project-references-dag`: 複雑な依存グラフ
- `errors-many`: 大量diagnostics

規模は環境変数または設定ファイルで変更可能にする。

完了条件：

- parse、check、emit、resolution、incrementalを個別に観察できる
- small、medium、largeのプリセットがある
- 各fixtureが何を測るか文書化されている

Issue #8では`errors-many`を除くfixture、3段階preset、stateful runner、生成scaleの
manifest検証を実装した。`errors-many`は大量diagnosticsの互換性分類と合わせて扱う
候補として残す。

### Phase 4 — 構造化された互換性比較

目的は、TS6とTS7の差を機械的に分類すること。

分類：

- `SUPPORTED_IDENTICALLY`
- `SUPPORTED_WITH_DIFFERENCE`
- `DEFAULT_CHANGED`
- `DEPRECATED_IN_TS6`
- `REMOVED_IN_TS7`
- `TS7_ONLY`
- `API_UNAVAILABLE`
- `POSSIBLE_REGRESSION`

実装内容：

- diagnostic code、file、line、column、messageの構造化
- 終了コードとdiagnostics本文の差を分離
- JavaScriptと`.d.ts`のファイル単位差分
- compiler optionごとの最小fixture
- TS6とTS7のデフォルト値比較
- 意図された差のmanifest
- 未知の差を`POSSIBLE_REGRESSION`として報告

完了条件：

- 主要compiler optionsに分類結果がある
- 「使えなくなったもの」を実行結果から一覧化できる
- 既知差と未知差を自動で区別できる

### Phase 5 — エコシステム互換性

目的は、CLI以外も含めた現実的な移行可能性を調べること。

検証候補：

- typescript-eslint / ESLint
- ts-node
- ts-jest / Vitest
- Vite / webpack
- custom transformers
- TypeDoc
- Angular
- Vue / Volar
- Svelte
- Astro
- MDX
- Next.js

各ツールを以下で分類する。

- TS7単独で利用可能
- CLIの型チェックのみTS7を利用可能
- TS6との共存が必要
- programmatic API待ち
- workaroundあり
- 現時点では利用不可

完了条件：

- 各ツールに最小再現fixtureがある
- バージョンと実行コマンドが記録されている
- 対応状況が推測ではなく実行結果に基づいている

### Phase 6 — 履歴比較とregression検出

目的は、TS7の更新や実装変更による推移を見ること。

実装内容：

- 任意の2つのrunを比較
- baseline runの指定
- fixture別の増減率
- regression threshold
- machine fingerprintによる比較可否の警告
- Markdown、JSON、CSV export
- 結果をGit管理する場合のsummary artifact生成

完了条件：

- 同一環境の過去runと比較できる
- 閾値を超えた性能低下を検出できる
- 異なるマシンの数値を不用意に直接比較しない

### Phase 7 — ローカルWeb UI

目的は、CLI出力を読まなくても結果を理解できるようにすること。

画面：

- Overview
- Performance
- Compatibility
- Diagnostics Diff
- Emit Diff
- Run History
- Environment

表示内容：

- TS6とTS7のfixture別グラフ
- speedup
- single-threadedとparallelの差
- checkers／builders数による変化
- メモリ使用量
- diagnostics、emitの差分
- compiler option対応表
- 過去runとの推移

初期UIは結果の閲覧専用とし、ブラウザから任意のコマンドを実行する機能は
別フェーズで検討する。

完了条件：

- `npm run dev`で起動できる
- 最新runと過去runを切り替えられる
- UIが固定schemaだけを参照する
- 主要な結論を画面だけで把握できる

### Phase 8 — CIと自動検証

実装内容：

- fixtureのsmoke test
- diagnosticsの期待値テスト
- emitのgolden test
- benchmark parserのunit test
- Linux、macOS、Windowsの互換性検証
- Node.js version matrix
- TSバージョン更新検知

共有CI runnerの性能値は変動が大きいため、通常CIでは互換性を中心に検証する。
性能regressionの判定は固定マシンまたは専用runnerへ分離する。

完了条件：

- Pull Requestで互換性の破壊を検出できる
- 性能値を共有runnerだけで断定しない
- TSの更新を再現可能な方法で検証できる

### Phase 9 — 実プロジェクトadapter

目的は、合成fixtureの結論を現実のコードベースで検証すること。

実装内容：

- ローカルプロジェクトを読み取り専用で測定
- プロジェクト別manifest
- install、typecheck、buildコマンドの定義
- ライセンス、source、commitの記録
- project固有の設定差分
- secretや生成物を収集しない安全設計

完了条件：

- 手元のプロジェクトをコピーせず測定できる
- OSSプロジェクトの特定commitで再現できる
- 合成fixtureと実プロジェクトの傾向を比較できる

### Phase 10 — 調査結果とポートフォリオの完成

最終的に次の問いへ答える。

- どの処理がどれくらい高速化したか
- 規模によってspeedupはどう変化するか
- ネイティブ化と並列化の効果をどこまで分離できたか
- メモリと開発時の待ち時間はどう変化したか
- TS6からの破壊的変更は何か
- TS6との共存が必要なのはどんな場合か
- TS7を導入しやすい／しにくいプロジェクトは何か

成果物：

- 技術レポート
- Notion向けポートフォリオ
- 再現手順
- スクリーンショットとグラフ
- 制約と今後の課題

## 5. 推奨する実装順

1. Phase 1: schemaと履歴保存
2. Phase 2: 測定の信頼性
3. Phase 4: 構造化diagnosticsと互換性分類
4. Phase 3: fixture拡充
5. Phase 6: 履歴比較
6. Phase 7: Web UI
7. Phase 5: エコシステム検証
8. Phase 8: CI
9. Phase 9: 実プロジェクト
10. Phase 10: 最終レポート

Phase番号は関心領域を表し、推奨実装順とは一致しない。UIをPhase 7としつつも、
UI着手前にPhase 1、2、4、6のデータ要件を固める。

## 6. GitHub Issue分割案

### Issue 1 — Define a versioned result schema

Labels: `phase: foundation`, `type: enhancement`, `priority: high`

- `schemaVersion`、`runId`、compiler／environment metadataを定義
- JSON Schemaを追加
- 既存結果を新schemaへ移行
- schema validation testを追加

### Issue 2 — Store benchmark runs as history

Labels: `phase: foundation`, `type: enhancement`, `priority: high`

- `results/runs/<run-id>/`へ保存
- latest runの参照方法を追加
- run一覧の読み込みAPIを用意
- Git管理対象と生成物の方針を文書化

Depends on: Issue 1

### Issue 3 — Improve benchmark statistics and execution order

Labels: `phase: benchmark`, `type: enhancement`, `priority: high`

- cold／warm runを分離
- 実行順序をランダム化または交互化
- mean、standard deviationを追加
- 外れ値候補を表示
- 失敗時も残りの測定を継続
- fixture単位のtimeoutを追加
- 同じ条件を再実行するための設定と実行順を保存

Depends on: Issue 1

### Issue 4 — Measure CPU time and peak memory

Labels: `phase: benchmark`, `type: enhancement`, `priority: medium`

- wall-clock以外の指標を収集
- macOS、Linux、Windowsで取得方法を整理
- 未対応環境では明示的に`unavailable`を保存
- CPU timeとpeak RSSを独立して取得可否判定
- resource collectorと測定scopeを結果に保存

Depends on: Issue 1

### Issue 5 — Add checker and builder scaling experiments

Labels: `phase: benchmark`, `type: experiment`, `priority: medium`

- `--checkers 1/2/4/8`
- `--builders 1/2/4`
- CPU数との関係をレポート
- 過剰並列時のメモリ増加を記録
- checkerは`many-files`、builderは独立leafを持つ専用DAGで測定
- worker 1をbaselineとしてwall-clock speedupとRSS比を表示
- logical CPU超過点がmatrixにない場合は、その事実を明示

Depends on: Issues 1 and 3

### Issue 6 — Parse and compare diagnostics structurally

Labels: `phase: compatibility`, `type: enhancement`, `priority: high`

- code、file、line、column、messageへ分解
- 終了コード差を独立して記録
- 既知差manifestを追加
- 未知差を`POSSIBLE_REGRESSION`として分類
- raw stdout／stderrを保持し、構造化後も元の出力を確認可能にする
- fixture名だけでなく差分全体を既知差manifestと照合する

Depends on: Issue 1

### Issue 7 — Build a TS6-to-TS7 compiler option catalog

Labels: `phase: compatibility`, `type: research`, `priority: high`

- deprecated、removed、default changedを分類
- compiler optionごとのfixtureを追加
- 代替設定とmigration noteを記録
- default changeはTS6で導入されTS7が採用した変更として、TS6／TS7差と区別
- optionごとの期待diagnosticとemit pathを固定し、未知の結果をregression候補にする

Depends on: Issue 6

### Issue 8 — Expand performance fixtures

Labels: `phase: fixtures`, `type: enhancement`, `priority: medium`

- parse、type-check、emit、declaration、resolution
- incremental、watch、project-reference DAG
- small、medium、large preset
- fixtureの目的と限界を文書化

Depends on: Issues 1 and 3

### Issue 9 — Compare two historical runs

Labels: `phase: reporting`, `type: enhancement`, `priority: medium`

- baseline指定
- fixture別増減率
- machine fingerprint警告
- regression threshold

Depends on: Issues 1 and 2

### Issue 10 — Build a read-only local dashboard

Labels: `phase: ui`, `type: enhancement`, `priority: medium`

- Overview、Performance、Compatibility
- Diagnostics Diff、Emit Diff
- Run History、Environment
- 固定schemaだけを参照

Depends on: Issues 1, 2, 6, and 9

### Issue 11 — Add ecosystem compatibility fixtures

Labels: `phase: ecosystem`, `type: research`, `priority: low`

- typescript-eslint、Vite、Vitestから開始
- framework／tool versionを固定
- TS7単独、TS6共存、利用不可を分類

Depends on: Issues 6 and 7

### Issue 12 — Add CI verification

Labels: `phase: ci`, `type: enhancement`, `priority: medium`

- fixture smoke test
- diagnostics expectation
- emit golden test
- cross-platform test
- 共有runnerの性能値を合否判定に使わない

Depends on: Issues 6 and 8

### Issue 13 — Add a local-project benchmark adapter

Labels: `phase: real-world`, `type: enhancement`, `priority: low`

- 読み取り専用adapter
- project manifest
- secretや成果物を収集しない
- OSSのsourceとcommitを記録

Depends on: Issues 1, 2, and 3

### Issue 14 — Publish the final technical report

Labels: `phase: documentation`, `type: documentation`, `priority: low`

- 測定結果と制約を整理
- グラフとスクリーンショットを追加
- Notionポートフォリオを更新
- GitHubの再現手順へリンク

Depends on: project findings

## 7. 次の着手範囲

最初の実装セットはIssue 1、2、3、6を推奨する。

これにより、UIとfixture追加に先立って次が確定する。

- 結果データの形
- 履歴の保存方法
- 測定統計
- diagnosticsの比較方法

この4点が安定すれば、後続機能を追加しても既存結果とUIを壊しにくい。
