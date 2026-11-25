package limits

// Len : places prises au total (tests).
func (k *Keyed) Len() int {
	k.mu.Lock()
	defer k.mu.Unlock()
	t := 0
	for _, v := range k.n {
		t += v
	}
	return t
}
