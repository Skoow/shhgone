package salon

import (
	"encoding/binary"
	"slices"
)

// encoderV1Locked : format de la version 1 (arrêt propre du binaire du 25 novembre), pour les
// tests de la mise à jour seulement. Appelé sous s.mu.
func (s *salon) encoderV1Locked() []byte {
	b := binary.BigEndian.AppendUint64(nil, s.seq)
	b = binary.BigEndian.AppendUint32(b, uint32(s.arrivees))
	b = append(b, bit(s.signale))
	for _, k := range s.signalements {
		b = binary.BigEndian.AppendUint32(b, uint32(k))
	}
	b = binary.BigEndian.AppendUint64(b, s.depart)
	b = binary.BigEndian.AppendUint64(b, s.gen.Load())
	b = append(b, bit(s.regle))
	b = binary.BigEndian.AppendUint64(b, uint64(ms(s.appelsJusqua)))
	b = append(b, uint8(s.occupesLocked()))
	for n, x := range s.sieges {
		if x == nil {
			continue
		}
		b = append(b, uint8(n))
		b = append(b, x.nonce[:]...)
		b = append(b, x.jetonV[:]...)
		for _, v := range []uint64{x.emis, x.plancher, x.arrivee, x.repris, x.derniere} {
			b = binary.BigEndian.AppendUint64(b, v)
		}
		b = append(b, bit(x.jamaisConnecte))
		b = binary.BigEndian.AppendUint64(b, uint64(ms(x.entre)))
		b = append(b, uint8(len(x.reprises)))
		for _, t := range x.reprises {
			b = binary.BigEndian.AppendUint64(b, uint64(ms(t)))
		}
	}
	b = binary.BigEndian.AppendUint32(b, uint32(len(s.revoques)))
	for h := range s.revoques {
		b = append(b, h[:]...)
	}
	b = binary.BigEndian.AppendUint32(b, uint32(len(s.journal)))
	for _, ev := range s.journal {
		b = binary.BigEndian.AppendUint64(b, ev.seq)
		b = append(b, uint8(len(ev.enr)))
		b = append(b, ev.enr...)
	}
	b = binary.BigEndian.AppendUint32(b, uint32(len(s.index)))
	for _, e := range s.index {
		b = binary.BigEndian.AppendUint64(b, e.seq)
		b = binary.BigEndian.AppendUint64(b, uint64(e.recuMs))
		b = binary.BigEndian.AppendUint64(b, uint64(e.attendus))
		b = binary.BigEndian.AppendUint32(b, e.emplacement)
		b = append(b, e.siege, e.drapeaux)
	}
	b = binary.BigEndian.AppendUint32(b, uint32(len(s.echeances)))
	for _, e := range s.echeances {
		b = binary.BigEndian.AppendUint64(b, uint64(e.ms))
		b = binary.BigEndian.AppendUint64(b, e.seq)
	}
	b = binary.BigEndian.AppendUint32(b, uint32(len(s.aEcraser)))
	for _, e := range s.aEcraser {
		b = binary.BigEndian.AppendUint32(b, e)
	}
	var pretes []*piece
	for _, p := range s.lesPieces {
		if p.etat == prete && !p.efface && p.ecritures == 0 {
			pretes = append(pretes, p)
		}
	}
	slices.SortFunc(pretes, func(a, c *piece) int { return cmpStr(a.id, c.id) })
	b = binary.BigEndian.AppendUint32(b, uint32(len(pretes)))
	for _, p := range pretes {
		b = append(b, uint8(len(p.id)))
		b = append(b, p.id...)
		b = binary.BigEndian.AppendUint32(b, uint32(p.bucket))
		b = append(b, bit(p.vocal), p.siege)
		b = append(b, p.auteur[:]...)
		for _, v := range []uint64{p.rang, p.lien, p.gen, uint64(p.places), uint64(ms(p.activite)), uint64(p.servis)} {
			b = binary.BigEndian.AppendUint64(b, v)
		}
		b = binary.BigEndian.AppendUint32(b, uint32(len(p.lus)))
		for jv, k := range p.lus {
			b = append(b, jv[:]...)
			b = binary.BigEndian.AppendUint64(b, uint64(k))
		}
	}
	return b
}
