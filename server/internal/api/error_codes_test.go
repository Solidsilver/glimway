package api

import (
	"bytes"
	contract "glimway/server/internal/gen/glimway/v1"
	"go/ast"
	"go/parser"
	"go/printer"
	"go/token"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// Scan production refusal sources against the generated enum. Dynamic error
// sources must remain explicitly covered when new refusals are introduced.
func TestClientErrorCodesCoverServer(t *testing.T) {
	codes := map[string]bool{}
	for n := range contract.ErrorCode_name {
		if n != 0 {
			codes[errorCodeWire(contract.ErrorCode(n))] = true
		}
	}
	fset := token.NewFileSet()
	check := func(expr ast.Expr) {
		lit, ok := expr.(*ast.BasicLit)
		if !ok || lit.Kind != token.STRING {
			t.Errorf("%s: error code must be a literal or have an explicit source scan", fset.Position(expr.Pos()))
			return
		}
		code, err := strconv.Unquote(lit.Value)
		if err != nil {
			t.Fatal(err)
		}
		if code != "" && !codes[code] {
			t.Errorf("%s: server emits %q, missing from client catalog", fset.Position(expr.Pos()), code)
		}
	}
	// These forwarded codes have their sources checked below. Fail closed if a
	// new dynamic emission is introduced without scanning its source.
	dynamic := map[string]bool{
		"ownLand:refusal":           true,
		"worldParty:why":            true,
		"settleChoice:why":          true,
		"mailSendLimits:check.code": true,
		"login:h.Code":              true,
		"spend:err.Error()":         true,
	}
	for _, dir := range []string{".", "../habitica", "../rules"} {
		paths, err := filepath.Glob(filepath.Join(dir, "*.go"))
		if err != nil {
			t.Fatal(err)
		}
		for _, path := range paths {
			if strings.HasSuffix(path, "_test.go") {
				continue
			}
			file, err := parser.ParseFile(fset, path, nil, 0)
			if err != nil {
				t.Fatal(err)
			}
			for _, decl := range file.Decls {
				fn, ok := decl.(*ast.FuncDecl)
				if !ok || fn.Body == nil {
					continue
				}
				ast.Inspect(fn.Body, func(n ast.Node) bool {
					switch v := n.(type) {
					case *ast.CallExpr:
						id, ok := v.Fun.(*ast.Ident)
						if !ok {
							break
						}
						if id.Name == "fail" && len(v.Args) == 2 {
							if _, literal := v.Args[1].(*ast.BasicLit); literal {
								check(v.Args[1])
							} else {
								var buf bytes.Buffer
								if err := printer.Fprint(&buf, fset, v.Args[1]); err != nil {
									t.Fatal(err)
								}
								if !dynamic[fn.Name.Name+":"+buf.String()] {
									t.Errorf("%s: unscanned dynamic error source %s:%s", fset.Position(v.Pos()), fn.Name.Name, buf.String())
								}
							}
						}
						if id.Name == "ownLand" {
							check(v.Args[len(v.Args)-1])
						}
					case *ast.CompositeLit:
						if id, ok := v.Type.(*ast.Ident); ok && id.Name == "failure" && fn.Name.Name != "fail" {
							check(v.Elts[1])
						}
						// Positional rows in the mail limit table feed check.code.
						if fn.Name.Name == "mailSendLimits" && v.Type == nil && len(v.Elts) == 4 {
							check(v.Elts[2])
						}
					case *ast.KeyValueExpr:
						if id, ok := v.Key.(*ast.Ident); ok && (dir == "../habitica" && id.Name == "Code" || dir == "../rules" && fn.Name.Name == "CheckSpend" && id.Name == "Reason") {
							check(v.Value)
						}
					case *ast.AssignStmt:
						if dir == "../rules" && fn.Name.Name == "CheckSpend" {
							for i, lhs := range v.Lhs {
								if sel, ok := lhs.(*ast.SelectorExpr); ok && sel.Sel.Name == "Reason" {
									check(v.Rhs[i])
								}
							}
						}
					case *ast.ReturnStmt:
						if fn.Name.Name == "mayOpenParty" && len(v.Results) == 2 {
							check(v.Results[0])
						}
					}
					return true
				})
			}
		}
	}
}
