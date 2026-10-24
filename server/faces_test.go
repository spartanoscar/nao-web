package main

import "testing"

func TestVectorRoundTrip(t *testing.T) {
	e := make([]float64, faceDims)
	for i := range e {
		e[i] = float64(i)/100 - 0.5
	}
	got, ok := parseVector(formatVector(e))
	if !ok || len(got) != faceDims {
		t.Fatalf("no volvió: %v %d", ok, len(got))
	}
	for i := range e {
		if d := got[i] - e[i]; d > 1e-6 || d < -1e-6 {
			t.Fatalf("valor %d: %v ≠ %v", i, got[i], e[i])
		}
	}
	if validEmbedding(e[:10]) {
		t.Fatal("una huella de 10 valores no es válida")
	}
}
