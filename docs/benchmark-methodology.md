# Benchmark methodology

## Execution phases

各fixtureとvariantを、次の3 phaseに分けて実行する。

1. `cold`: lab run内で最初の未warm-up実行を1回記録する
2. `warmup`: `LAB_WARMUPS`回実行する
3. `measured`: `LAB_RUNS`回実行し、統計の対象にする

coldはOSのfilesystem cache、CPU状態、TypeScriptが利用する共有cacheを初期化した
厳密なcold環境ではない。他variantが先に実行されることで共有cacheが温まる可能性も
あるため、プロセス起動直後の参考値として扱い、warm統計には混ぜない。

## Execution order

`rotating-v1`は、各roundでそのfixtureへ適用可能なvariantの先頭を1つずつずらす。
次は通常比較の3 variantでoffsetが0から
始まる場合の基準例であり、実際の先頭はfixture位置とphaseによって変わる。

```text
round 0: ts6 → ts7-single → ts7-default
round 1: ts7-single → ts7-default → ts6
round 2: ts7-default → ts6 → ts7-single
```

fixtureの位置とcold／warmupの回数もoffsetへ反映する。実際に使用した順序は
`configuration.executionPlan`へ全件保存するため、結果から監査できる。

## Statistics

成功した`measured` attemptだけを対象に、以下を計算する。

- median
- nearest-rank p95
- arithmetic mean
- population standard deviation（分散をsample数`N`で割る。`N = 1`では0）
- minimumとmaximum

外れ値候補は、成功sampleが4件以上ある場合にTukeyの1.5×IQRで判定する。
quartileは線形補間で計算し、fenceと同じ値は候補に含めない。候補は表示するだけで、
統計から自動的に除外しない。少数sampleで候補がないことを、ばらつきがない証拠とは
解釈しない。

## Failures and timeout

compilerの非ゼロ終了、timeout、process起動失敗を別のstatusで保存する。各attemptには
phase、round、実行順、経過時間、exit code、signal、stdout、stderr、runner errorを
記録する。1回の失敗でbenchmark全体を停止せず、scheduleの残りを実行する。

timeoutはcompiler invocation単位で、既定値は120000msである。期限を超えたprocessへ
`SIGTERM`を送り、終了しない場合は1秒後に`SIGKILL`を送る。
直接実行時はcompiler processを終了する。resource collectorを使うUnix環境では、
collectorとcompilerを同じprocess groupで起動し、timeout時にgroup全体を終了する。

CPU timeとpeak RSSを取得するときはcompilerを`/usr/bin/time`でラップするため、
wall-clockにはcollector起動の小さなoverheadも含まれる。全variantへ同じcollectorを
使い、overheadの推測値を測定値から減算しない。

## Replaying conditions

`configuration.replay`には、実行コマンドと以下の環境変数を保存する。

- `LAB_RUNS`
- `LAB_WARMUPS`
- `LAB_FIXTURE_TIMEOUT_MS`
- `LAB_FILE_COUNT`

fixtureとvariantの引数、compiler version、Git commit、hardware、実際のexecution planも
resultに含まれる。再実行は新しいrun IDを生成し、過去のrunを上書きしない。
`LAB_FILE_COUNT`には環境変数の推測値ではなく、測定直前に
`fixtures/many-files/src/`で確認したTypeScriptファイル数を保存する。

scaling実験のworker数は、実際に常時稼働したworker数ではなくCLIへ指定した上限で
ある。checkerとbuilderの適用対象・固定条件・集計方法は
`docs/scaling-experiments.md`に記録する。
