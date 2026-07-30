# TypeScript 7 Migration Lab

## プロジェクトの目的

このリポジトリは、TypeScript 6とGoベースのTypeScript 7を比較するための、
再現可能な実験環境である。性能と互換性を別々の問いとして扱い、記録された
測定結果を根拠に結論を出すこと。

以下をプロジェクトの正本とする。

- `docs/roadmap.md`: 実装計画と実験設計
- GitHub Issues: 作業範囲と完了条件
- `README.md`: 公開向けのセットアップと利用手順

## 作業ルール

- 一度に1件のGitHub Issueへ取り組み、その完了条件の範囲内で変更する。
- TypeScript 6とTypeScript 7を共存させる構成を維持する。
- `fixtures/many-files/src/`、`results/`、`reports/`配下の生成ファイルを
  直接編集しない。
- `node_modules`、ベンチマーク結果、ビルド成果物、`*.tsbuildinfo`を
  コミットしない。
- スクリプトは`package.json`で宣言されたNode.jsバージョンとの互換性を保つ。
- Node.js標準ライブラリで十分な場合は、本番依存パッケージを追加しない。
- 挙動、コマンド、実験上の前提を変更した場合は、`README.md`、
  `docs/roadmap.md`、または該当fixtureのドキュメントを更新する。

## 実験の整合性

- コンパイラ性能を測定するときは、TypeScript 6、`--singleThreaded`を指定した
  TypeScript 7、デフォルトの並列設定を使用したTypeScript 7を比較する。
- ベンチマーク結果には、コンパイラのバージョン、実行環境、fixtureの規模、
  warm-up回数、計測回数を記録する。
- quick runや小規模fixtureの結果を、すべてのTypeScriptプロジェクトを
  代表する結果として扱わない。
- TS6とTS7の差をすべてGoへの移植効果として説明しない。実験で可能な範囲で、
  ネイティブ実装と並列化の効果を区別する。
- バージョン間の比較では、入力とcompiler optionsを同等に保つ。意図的な差が
  ある場合は文書化する。
- コンパイラの失敗、終了コード、diagnostics、emitの差を、それぞれ独立した
  観測結果として扱う。
- 既知の意図された変更とregressionの可能性を分けて分類する。
- 正規化や構造化によって意味のある差が隠れる可能性がある場合は、raw outputも
  保存する。

## 生成物

- `fixtures/many-files/src/`は`npm run fixtures:generate`で生成する。
- `results/benchmark.json`と`results/comparison.json`は測定データとして
  生成する。
- `reports/latest.md`はresult filesから生成する。
- 生成物を直接編集せず、`package.json`のscriptsを使って再生成する。

## 検証ルール

- ベンチマークまたはfixture生成スクリプトを変更した後は、
  `npm run lab:quick`を実行する。
- diagnosticsまたはemitの比較ロジックを変更した後は、
  `npm run compare`を実行する。
- レポート生成を変更した後は、`npm run report`を実行する。
- ワークフロー全体を変更した後は、`npm run lab:quick`を実行する。
- ドキュメントのみの変更ではベンチマーク実行を必須としない。ただし、記載した
  コマンドとファイル参照が`package.json`および実際の構成と一致することを
  確認する。
- 作業完了時には、実行したコマンドと確認された失敗を報告する。

## コードレビューのルール

- 理由を文書化せず、入力または重要なcompiler optionsが異なる状態で比較して
  いる場合は指摘する。
- 実行環境と計測回数を示していない性能上の主張を指摘する。
- TS7で意図された挙動変更を、自動的にregressionとして扱う実装を指摘する。
- ベンチマーク結果、レポート、fixture生成物を直接編集する変更を指摘する。
- コンパイラ出力または失敗したrunを暗黙に破棄する変更を指摘する。
