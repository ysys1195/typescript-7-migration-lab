# TypeScript 7は何が速くなったのか — 自分のマシンで検証できるMigration Labを作る

> Notion掲載用のドラフトです。測定を追加するたびに「結果」と「学び」を更新します。

## 概要

TypeScript 7では、従来JavaScriptとして動いていたTypeScriptコンパイラと
ツール群が、Goによるネイティブ実装へ移行しました。

公式には大幅な高速化が紹介されています。しかし、単に「Goになって速くなった」
と理解するだけでは、次の疑問が残ります。

- 自分の開発環境ではどの程度速くなるのか
- パース、型チェック、emitのどこが速くなったのか
- ネイティブ化と並列化は、それぞれどの程度効いているのか
- 高速化と引き換えに利用できなくなった機能はあるのか
- 既存プロジェクトはそのまま移行できるのか

これらを推測ではなく実験結果から理解するため、TypeScript 6とTypeScript 7を
同じ条件で比較する「TypeScript 7 Migration Lab」を作っています。

## このプロジェクトで検証すること

大きく分けて、性能と互換性の2軸で検証します。

### 性能

- コンパイル全体の時間
- parse、bind、check、emitの内訳
- single-threadedとparallelの差
- ファイル数や型計算量による変化
- project references
- incremental buildとwatch mode
- メモリ使用量

### 互換性

- diagnosticsのcode、位置、メッセージ
- 生成されるJavaScript
- declaration file
- compiler options
- デフォルト設定
- JSXとJSDoc
- compiler API
- 周辺ツールとフレームワーク

## なぜTS7 single-threadedも測るのか

TypeScript 7が高速化した理由は、Goへの移植だけではありません。ネイティブコード、
データ構造の変更、共有メモリ、複数workerによる並列化などが組み合わさっています。

そこで、このラボでは次の3条件を比較します。

1. TypeScript 6
2. TypeScript 7 `--singleThreaded`
3. TypeScript 7 default

TS6とTS7 single-threadedの差からネイティブ実装全体による効果を、TS7
single-threadedとdefaultの差から並列化による追加効果を概算します。

内部実装は完全に同一ではないため、厳密な因果分解ではありません。それでも、
TS6とTS7の合計時間だけを比較するより、高速化の内訳を考察しやすくなります。

## 現在実装できていること

- TypeScript 6.0.3とTypeScript 7.0.2の共存
- warm-upを含む反復ベンチマーク
- medianとp95の計算
- `--extendedDiagnostics`の収集
- TS6、TS7 single-threaded、TS7 defaultの比較
- diagnostics比較
- JavaScriptと`.d.ts`のemit比較
- MarkdownとJSONレポート
- 400ファイルを生成するfixture
- JSX、JSDoc、型計算、project referencesのfixture

すべての実験は次のコマンドで再実行できます。

```bash
npm install
npm run lab
```

短時間で確認する場合は次を使います。

```bash
npm run lab:quick
```

## 最初の測定結果

初回はApple M1、8 logical CPUsの環境で、各ケースをwarm-up 1回、計測3回の
quick runとして実行しました。

| Fixture | TS6 | TS7 single | TS7 default | Speedup |
|---|---:|---:|---:|---:|
| small | 658.6 ms | 236.7 ms | 228.3 ms | 2.88x |
| type-heavy | 615.5 ms | 236.8 ms | 226.7 ms | 2.72x |
| many-files | 724.3 ms | 267.2 ms | 247.5 ms | 2.93x |
| JSX | 616.2 ms | 235.3 ms | 225.5 ms | 2.73x |
| JSDoc | 613.0 ms | 247.3 ms | 237.0 ms | 2.59x |
| monorepo | 1003.8 ms | 386.5 ms | 374.3 ms | 2.68x |

この環境ではTS7が約2.6〜2.9倍高速でした。

ただし、現時点のfixtureは小さく、実行時間のうちプロセス起動時間が占める割合が
大きいと考えられます。そのため、この数値を「TS7は常に約3倍速い」という結論には
していません。今後、より大規模なfixtureと起動時間baselineを追加します。

## 互換性について分かったこと

現時点のfixtureでは、通常のTypeScript、複雑な型、JSX、JSDocについて、
TS6とTS7のdiagnosticsは一致しました。

意図的に3つの型エラーを含めたfixtureでも、エラーコード、位置、メッセージは
一致しました。一方、プロセス終了コードはTS6が`2`、TS7が`1`でした。

また、emit fixtureで生成されたJavaScriptと`.d.ts`は一致しました。

古いcompiler optionsでは、TS6が「非推奨」と報告する設定を、TS7は
「削除済み」として報告します。このような意図された差をregressionと混同しない
分類方法も実装していきます。

## 実装で意識したこと

### 測定結果を鵜呑みにしない

ベンチマークでは、warm-up、複数回実行、medianを使っています。今後は実行順序、
標準偏差、外れ値、CPU time、peak memoryも扱います。

### 失敗もデータとして扱う

コンパイルできなかったこと自体が互換性の情報です。成功した測定だけではなく、
終了コードやdiagnosticsも保存します。

### 意図された変更と未知の差を分ける

差があっただけで「TS7のバグ」とは判断しません。既知の削除、デフォルト変更、
API未対応、未知の差に分類します。

### UIの前にデータ形式を固める

グラフを先に作るのではなく、実験結果のschemaと履歴保存を先に設計します。
これにより、fixtureが増えてもUIを作り直しにくい構成を目指します。

## 今後のロードマップ

次の順で進める予定です。

1. 結果JSONのversioned schema
2. 実行履歴と環境情報の保存
3. ベンチマーク統計の改善
4. diagnosticsの構造化比較
5. compiler option互換性カタログ
6. 性能fixtureの拡充
7. 過去runとの比較
8. ローカルWebダッシュボード
9. 周辺ツール・フレームワーク検証
10. CIと実プロジェクト検証

詳細な計画と受け入れ条件はGitHubリポジトリのロードマップにまとめています。

## このプロジェクトを通して示したいこと

このプロジェクトは、TypeScript 7の機能紹介だけを目的にしていません。

- 新しい技術を自分で検証する
- 仮説を測定可能な形に分解する
- 再現可能な実験を設計する
- 数字の制約を明示する
- 互換性を実行結果で判断する
- CLI、データ設計、UI、CIまで一貫して構築する

という開発姿勢を、コードと結果の両方で示すことを目指しています。

## Links

- GitHub: `公開後にURLを追加`
- Detailed roadmap: `GitHub上のdocs/roadmap.mdへのリンクを追加`
- Latest report: `GitHub上のレポートまたはスクリーンショットへのリンクを追加`

## 次回更新予定

- versioned result schema
- run履歴
- 起動時間baseline
- diagnosticsの構造化

測定条件と結論が変わった場合は、過去の結果を消さず、更新理由とともに追記します。
