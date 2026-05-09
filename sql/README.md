# SQL Directory Guide

このディレクトリはDB種別で分離する。

## ClickHouse

```text
sql/clickhouse/
```

ClickHouseで実行するSQLだけを置く。

Postgresでは実行しない。

## Postgres

```text
sql/postgres/
```

Postgresで実行するSQLだけを置く。

ClickHouseでは実行しない。

既存Postgres SQLはすべて `sql/postgres/` 配下へ集約する。

```text
sql/postgres/table/
sql/postgres/view/
sql/postgres/mview/
sql/postgres/function/
sql/postgres/cron/
sql/postgres/procedure/
sql/postgres/maintenance/
```

ClickHouse移行用にPostgresへ追加するcheckpoint/lock DDLもPostgresで実行するため、`sql/postgres/clickhouse/` 配下に置く。

```text
sql/postgres/clickhouse/sync_state.sql
```

## Rule

- `sql/clickhouse/**`: ClickHouse専用
- `sql/postgres/**`: Postgres専用
- `sql/README.md`: この説明だけ
