package sqlschema

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

const mysqlDDL = `
-- 주문
CREATE TABLE IF NOT EXISTS ` + "`shop`.`orders`" + ` (
  ` + "`id`" + ` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '주문 ID',
  member_id bigint NOT NULL,
  amount decimal(12,2) DEFAULT 0,
  status enum('READY','DONE') NOT NULL,
  PRIMARY KEY (id),
  KEY idx_member (member_id),
  CONSTRAINT fk FOREIGN KEY (member_id) REFERENCES members (id)
) ENGINE=InnoDB COMMENT='주문 테이블';

ALTER TABLE orders ADD COLUMN memo varchar(200) NULL, ADD INDEX idx_memo (memo);

CREATE OR REPLACE ALGORITHM=MERGE DEFINER=` + "`root`@`%`" + ` VIEW v_orders AS
SELECT o.id, o.amount AS total, COUNT(*) cnt FROM orders o GROUP BY o.id;
`

func TestParseMySQL(t *testing.T) {
	ts := Parse(mysqlDDL, "ddl.sql")
	if len(ts) != 2 {
		t.Fatalf("tables = %+v", ts)
	}
	o := ts[0]
	if o.Schema != "shop" || o.Name != "orders" || o.Comment != "주문 테이블" || o.Kind != "table" {
		t.Fatalf("orders = %+v", o)
	}
	if o.Line != 3 {
		t.Errorf("orders line = %d, want 3", o.Line)
	}
	want := []Column{
		{"id", "bigint unsigned", "주문 ID", 4},
		{"member_id", "bigint", "", 5},
		{"amount", "decimal(12, 2)", "", 6},
		{"status", "enum('READY', 'DONE')", "", 7},
		{"memo", "varchar(200)", "", 13},
	}
	if len(o.Columns) != len(want) {
		t.Fatalf("columns = %+v", o.Columns)
	}
	for i, c := range want {
		if o.Columns[i] != c {
			t.Errorf("col %d = %+v, want %+v", i, o.Columns[i], c)
		}
	}
	v := ts[1]
	if v.Line != 15 {
		t.Errorf("view line = %d, want 15", v.Line)
	}
	if v.Name != "v_orders" || v.Kind != "view" || len(v.Columns) != 3 || v.Columns[1].Name != "total" || v.Columns[2].Name != "cnt" {
		t.Fatalf("view = %+v", v)
	}
}

func TestParseOracleComments(t *testing.T) {
	src := `CREATE TABLE HR.EMP (EMPNO NUMBER(4) NOT NULL, ENAME VARCHAR2(10));
COMMENT ON TABLE HR.EMP IS '사원';
COMMENT ON COLUMN HR.EMP.ENAME IS '사원명';
CREATE GLOBAL TEMPORARY TABLE tmp_x (a int) ON COMMIT DELETE ROWS;
CREATE TABLE copy_t AS SELECT * FROM emp;
CREATE INDEX idx ON emp (ename);`
	ts := Parse(src, "x.sql")
	if len(ts) != 2 {
		t.Fatalf("tables = %+v", ts)
	}
	e := ts[0]
	if e.Schema != "HR" || e.Comment != "사원" || e.Columns[1].Comment != "사원명" || e.Columns[0].Type != "NUMBER(4)" {
		t.Fatalf("emp = %+v", e)
	}
	if ts[1].Name != "tmp_x" {
		t.Fatalf("tmp = %+v", ts[1])
	}
}

func TestScanFolder(t *testing.T) {
	d := t.TempDir()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.MkdirAll(filepath.Join(d, "ddl"), 0o755))
	must(os.MkdirAll(filepath.Join(d, "node_modules"), 0o755))
	must(os.WriteFile(filepath.Join(d, "ddl", "a.sql"), []byte("create table a (x int);"), 0o644))
	must(os.WriteFile(filepath.Join(d, "node_modules", "b.sql"), []byte("create table b (y int);"), 0o644))
	must(os.WriteFile(filepath.Join(d, "c.md"), []byte("create table c (z int);"), 0o644))
	ts, err := Scan(context.Background(), d)
	must(err)
	if len(ts) != 1 || ts[0].Name != "a" || ts[0].File != "ddl/a.sql" {
		t.Fatalf("scan = %+v", ts)
	}
}
