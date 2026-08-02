# TypeScript 7 Migration Lab

TypeScript 6（JavaScript実装）とTypeScript 7（Goによるネイティブ実装）を、
同じ入力・同じマシンで比較するための実験リポジトリです。

## Project documents

- [実装ロードマップ](docs/roadmap.md)
- [Notion向けポートフォリオ原稿](docs/portfolio-draft.md)
- [測定結果のschema](docs/result-schema.md)

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

通常測定はwarm-up 2回、計測10回です。

```bash
npm run lab
```

結果は以下に生成されます。

- `results/benchmark.json`: 生の測定値と`--extendedDiagnostics`
- `results/comparison.json`: diagnosticsとemitの比較
- `reports/latest.md`: 読みやすいサマリー

生成されるJSONは`schemas/result.schema.json`で検証されます。

```bash
npm run validate
npm run test:schema
```

## Measuring different sizes

```bash
LAB_FILE_COUNT=1000 LAB_RUNS=20 LAB_WARMUPS=3 npm run lab
```

| 変数 | デフォルト | 意味 |
|---|---:|---|
| `LAB_FILE_COUNT` | 400 | many-files fixtureのファイル数 |
| `LAB_RUNS` | 10 | 各ケースの計測回数 |
| `LAB_WARMUPS` | 2 | 計測前のwarm-up回数 |

## Experiment design

各fixtureを次の3条件で測定します。

1. `tsc6`: TypeScript 6
2. `tsc --singleThreaded`: TypeScript 7の単一スレッド動作
3. `tsc`: TypeScript 7のデフォルト並列動作

TS6とTS7 single-threadedの差からネイティブ実装の効果を、TS7
single-threadedとdefaultの差から並列化の効果を概算できます。ただし、
内部実装が完全に同一ではないため、厳密な因果分解ではありません。

短い処理ではプロセス起動時間の比率が高くなります。実際のプロジェクトに近い
判断には`many-files`、`type-heavy`、`monorepo`を重視してください。

## Fixtures

- `small`: 起動コストが支配的な小規模プロジェクト
- `type-heavy`: conditional、mapped、template literal types
- `many-files`: 自動生成される多数ファイル
- `jsx`: JSXのパースと型チェック
- `jsdoc`: JavaScript + JSDoc + `checkJs`
- `monorepo`: project referencesとbuild mode
- `diagnostics`: 意図的な型エラー
- `emit`: JavaScriptと`.d.ts`の比較
- `legacy-options`: TS7で削除・変更された設定の観察

## Important limitation

TypeScript 7.0には安定したprogrammatic APIがまだありません。このラボは
TS7のCLIを使い、API依存ツールのためにTS6互換パッケージを同居させています。
