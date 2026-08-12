# Builder scaling fixture

`--builders`の並列度を比較するためのproject-reference DAGである。`core`を先に
buildした後、相互依存しない4つのleaf projectを同時にbuildできる。各測定では
`--force`を指定し、incremental cacheの状態にかかわらず同じ5 projectを対象にする。

このfixtureはbuilder schedulingを観測するための小規模な合成入力であり、実際の
monorepo全般を代表しない。
