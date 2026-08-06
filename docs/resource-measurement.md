# CPU time and peak RSS measurement

## Metrics

- CPU time: timed processについて報告されたuser CPU timeとsystem CPU timeの合計
- peak RSS: timed processについて報告されたmaximum resident set size

CPU timeは全threadの消費時間を合計するため、並列処理ではwall-clock timeを超える
場合がある。peak RSSは物理メモリ上にresidentだった最大量であり、heap sizeや
仮想メモリ量とは異なる。

## Platform adapters

| Platform | Command | CPU source | RSS normalization |
|---|---|---|---|
| macOS | `/usr/bin/time -lp -o <file>` | `user` + `sys` | 出力値をbytesとして保存 |
| Linux | GNU `/usr/bin/time -v -o <file>` | `User time` + `System time` | KiBを1024倍してbytesへ変換 |
| Windows | 未対応 | `unavailable` | `unavailable` |

macOSで`-l`によるRSS取得だけが失敗する環境では、`/usr/bin/time -p`へ
フォールバックし、CPU時間のみを保存する。

LinuxではGNU timeの形式だけを対象とする。BusyBoxなど異なる実装や、toolが存在しても
必要な項目を取得できない環境は未対応として扱う。GNU timeのresource fieldsは
[GNU Time manual](https://www.gnu.org/software/time/manual/time.html)を参照する。

collector outputはcompilerのstderrと混ぜず、一時ファイルへ保存する。locale差を
避けるため`LC_ALL=C`を指定し、測定後に一時ファイルを削除する。

## Capability probe and unavailable values

benchmark開始時に短いNode.js processをcollectorで測定し、exit code、CPU time、
peak RSSを確認する。macOSの`darwin-time-l` probeがRSS取得を理由に失敗してもCPU時間を
parseできた場合は、`darwin-time-p`で再probeし、CPUのみを測定する。それ以外でprobeが
失敗した場合、compilerは従来どおり直接起動し、両metricを理由付き`unavailable`として
保存する。OS名やtoolの存在だけで対応済みとは判定しない。

CPU timeとpeak RSSは独立したtagged unionで保存する。片方の項目だけparseできない
場合も、取得できたmetricは保持する。欠落値を0で補完しない。短時間processに対して
collectorが明示的にCPU time 0を返した場合だけ、0を有効な測定値として保存する。

## Failures and timeout

compilerが非ゼロ終了してもcollector outputが完成していればattemptへresource usageを
残す。timeoutとrunner errorでは測定が完了したとみなさず、resource metricsを
`unavailable`にする。

Unixのcollector利用時は新しいprocess groupで起動し、timeoutではcollectorとcompilerへ
まとめて`SIGTERM`を送る。1秒後も終了しない場合は`SIGKILL`を送る。`time`wrapperを
利用するため、signal終了が数値のexit statusへ変換され、元signalを保持できない場合が
ある。

## Aggregation and comparison limits

resource statisticsは、compilerが成功した`measured` attemptのうち、そのmetricが
availableなsampleだけを対象にする。cold、warmup、compiler failureはattemptには残すが
集計から除外する。metricごとにavailable／unavailable sample数を保存する。

OSの`time`／`rusage`が示すpeak RSSは、将来TS7が別processのworkerを起動した場合に
worker群の同時RSS合計を表すとは限らない。異なるOSでは計測scopeと実装が異なるため、
RSSの絶対値を直接比較しない。collector名、OS、compiler versionが同じrunを優先して
比較する。
