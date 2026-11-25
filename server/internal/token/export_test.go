package token

// Check vérifie la signature, le type, l'id et l'expiration, et rend le n° d'ouverture.
func (s *Signer) Check(tok string, kind byte, id string) (int, error) {
	n, _, err := s.CheckExp(tok, kind, id)
	return n, err
}
