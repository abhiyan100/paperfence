package internal

import "testing"

func TestAllowedUnderLimit(t *testing.T) {
	if !Allowed(10) {
		t.Fatal("10 should be allowed")
	}
}

func TestRejectsOverLimit(t *testing.T) {
	if Allowed(BurstLimit + 1) {
		t.Fatal("over the limit should be rejected")
	}
}
