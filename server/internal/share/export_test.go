package share

// charge : chargeAll sans plafond de partage (tests).
func (b *readBudget) charge(k openKey, n, limit, now int64) bool {
	return b.chargeAll(k, n, limit, 0, now) == nil
}
