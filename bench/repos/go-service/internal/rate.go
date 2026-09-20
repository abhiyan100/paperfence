package internal

// BurstLimit is the number of events accepted in a single window.
const BurstLimit = 240

// Allowed reports whether a count is within the burst limit.
func Allowed(count int) bool {
	return count <= BurstLimit
}
