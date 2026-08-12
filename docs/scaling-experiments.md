# Checker and builder scaling experiments

## Questions

TS7へ指定するchecker／builderの並列度を増やしたとき、wall-clock、CPU time、
peak RSSがどう変わるかを測定する。worker数以外の入力とcompiler optionsを固定し、
速度とメモリのtrade-offを別々に表示する。

## Matrices

| Axis | Fixture | Values | Fixed condition | Baseline |
|---|---|---|---|---|
| checkers | `many-files` | 1, 2, 4, 8 | 同じ400 filesとtsconfig | 1 |
| builders | `builder-scaling` | 1, 2, 4 | `--checkers 1`、`--force` | 1 |

`ts7-single`はchecker以外の並列処理も無効化するため、`--checkers 1`のbaselineとして
扱わない。builder fixtureは共通coreの後に4つの独立leaf projectをbuildできるDAGで、
既存の直列的な`monorepo` fixtureとは分離する。

## Metrics

同じaxis／fixtureのworker 1を基準に、次を計算する。

```text
speedup = median wall-clock at workers 1 / median wall-clock at workers N
RSS delta = median peak RSS at workers N - median peak RSS at workers 1
RSS ratio = median peak RSS at workers N / median peak RSS at workers 1
```

CPU timeとpeak RSSは成功したmeasured attemptのavailable sampleだけを使う。RSSを
取得できない環境ではdeltaとratioも`unavailable`とし、0で補完しない。

## CPU count and over-subscription

結果にはmachineのlogical CPU数と`requested workers / logical CPUs`を表示する。
`requested workers > logical CPU count`のpointだけをoversubscribedと分類する。
固定matrixの最大値がCPU数以下なら、過剰並列を観測したとは主張せず、該当pointが
ないことをレポートする。

CLIへ指定したworker数は並列度の上限であり、すべてのworkerが常時稼働した証拠では
ない。特にbuilder DAGでは依存関係と各projectの処理時間により実効並列度が変わる。
peak RSSもOS collectorのtimed-process scopeであり、worker群の同時RSS合計を常に
表すとは限らない。
