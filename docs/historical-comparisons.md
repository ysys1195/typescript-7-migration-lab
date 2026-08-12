# Historical run comparisons

履歴比較は、completeな2つのlab runをbaselineとtargetとして読み、性能と互換性の
変化をMarkdown、JSON、CSVへ出力する。targetを省略した場合は
`results/latest.json`が指すrunを使う。

```bash
npm run runs -- --complete-only
npm run compare:runs -- --baseline <run-id>
npm run compare:runs -- --baseline <run-id> --target <run-id>
```

既定のregression thresholdは10%である。CLI optionまたは環境変数で変更できる。

```bash
npm run compare:runs -- --baseline <run-id> --threshold 5
LAB_REGRESSION_THRESHOLD_PERCENT=7.5 npm run compare:runs -- --baseline <run-id>
```

生成物は次のdirectoryへ保存する。

```text
reports/comparisons/<baseline-run-id>--<target-run-id>/
├── comparison.json
├── comparison.md
└── comparison.csv
```

JSONは`schemas/run-comparison.schema.json`で検証する。比較生成物は元runの代わりでは
なく、`results/runs/<run-id>/`の正本から再生成できるsummaryであるためGitへcommit
しない。

## Performance classification

性能は`fixture/variant`の組ごとに、成功した計測のmedian wall-clock timeを比較する。
変化率は次の式で計算し、正の値はtargetが遅く、負の値は速いことを示す。

```text
(target median - baseline median) / baseline median × 100
```

| Classification | 条件 |
|---|---|
| `REGRESSION` | 比較可能で、正の変化率がthresholdを超える |
| `IMPROVEMENT` | 比較可能で、負の変化率の絶対値がthresholdを超える |
| `STABLE` | 比較可能で、変化率が±threshold以内 |
| `NOT_COMPARABLE` | 数値はあるがmachine、Node、測定条件、または入力が異なる |
| `ADDED` | targetにだけfixture/variantがある |
| `REMOVED` | baselineにだけfixture/variantがある |
| `UNAVAILABLE` | 有効なmedianまたは0より大きいbaselineがない |

thresholdとちょうど同じ変化は`STABLE`とする。計測失敗や追加・削除を0msへ置き換え
ない。

## Comparability

machine fingerprintは次を正規化してSHA-256で識別する。

- OS platformとarchitecture
- CPU modelとlogical CPU数
- 総メモリ

fingerprintに加え、Node.js version、runs／warm-ups／cold run／timeout／実行順／
resource collector、fixture command、variant args、size presetを比較する。machine、
Node、または測定条件が異なる場合は全性能
行、fixture／variant／presetが異なる場合は影響する行を`NOT_COMPARABLE`とする。変化率
自体は調査用に残すが、thresholdを超えてもregressionやimprovementとは断定しない。

baselineまたはtargetのfixture/variant結果が`partial`または`failed`の場合も、成功sample
の変化率は残す一方でthreshold判定を抑制する。

片方でもdirty worktreeで測定されたrunには注意を出す。Git commitやcompiler versionの
違いは履歴比較の対象そのものになり得るため、それだけでは比較不能にしない。

## Compatibility changes

diagnostics、emit、compiler optionの観測を正規化し、statusとevidenceのfingerprintを
比較する。

- `UNCHANGED`: statusと記録されたevidenceが同じ
- `CHANGED`: statusまたはevidenceが変化
- `ADDED`: targetで観測が追加
- `REMOVED`: targetで観測が削除

`CHANGED`は調査対象を示すものであり、自動的にregressionとは扱わない。詳細は両runの
`comparison.json`に保存されたstructured diagnosticsとraw outputを確認する。
