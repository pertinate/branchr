//! H.264 bitstream fixups applied once per frame before fan-out.

/// Splits an Annex B buffer into NAL units (without start codes).
fn nal_units(b: &[u8]) -> Vec<&[u8]> {
    let mut starts = Vec::new();
    let mut i = 0;
    while i + 2 < b.len() {
        if b[i] == 0 && b[i + 1] == 0 && b[i + 2] == 1 {
            starts.push((i, i + 3));
            i += 3;
        } else {
            i += 1;
        }
    }
    let mut out = Vec::with_capacity(starts.len());
    for (n, &(_, body)) in starts.iter().enumerate() {
        let mut end = starts.get(n + 1).map(|s| s.0).unwrap_or(b.len());
        // A 4-byte start code leaves a trailing zero on the previous unit.
        while end > body && b[end - 1] == 0 && n + 1 < starts.len() {
            end -= 1;
        }
        out.push(&b[body..end]);
    }
    out
}

/// Some encoders (seen with Chromium's VA-API H.264 path) produce keyframes whose SPS/PPS
/// come *after* the IDR slice. Decoders need parameter sets first, so such frames never
/// decode and the receiver loops on keyframe requests. Returns a reordered Annex B buffer
/// (SPS, PPS, then everything else) when needed.
pub fn reorder_parameter_sets(frame: &[u8]) -> Option<Vec<u8>> {
    let nals = nal_units(frame);
    let ty = |n: &[u8]| n.first().map(|b| b & 0x1f).unwrap_or(0);
    let first_slice = nals.iter().position(|n| matches!(ty(n), 1 | 5))?;
    let late_params = nals[first_slice..].iter().any(|n| matches!(ty(n), 7 | 8));
    if !late_params {
        return None;
    }
    let mut out = Vec::with_capacity(frame.len() + 8);
    let rank = |n: &[u8]| match ty(n) {
        7 => 0,
        8 => 1,
        _ => 2,
    };
    let mut ordered = nals.clone();
    // Stable: keeps the original order among slices / SEI.
    ordered.sort_by_key(|n| rank(n));
    for n in ordered {
        out.extend_from_slice(&[0, 0, 0, 1]);
        out.extend_from_slice(n);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn annexb(nals: &[&[u8]]) -> Vec<u8> {
        nals.iter().flat_map(|n| [&[0u8, 0, 0, 1][..], n].concat()).collect()
    }

    #[test]
    fn moves_late_parameter_sets_first() {
        let idr: &[u8] = &[0x65, 1, 2, 3];
        let sps: &[u8] = &[0x67, 4, 5];
        let pps: &[u8] = &[0x68, 6];
        let fixed = reorder_parameter_sets(&annexb(&[idr, sps, pps])).unwrap();
        assert_eq!(fixed, annexb(&[sps, pps, idr]));
    }

    #[test]
    fn leaves_correct_order_alone() {
        let f = annexb(&[&[0x67, 1], &[0x68, 2], &[0x65, 3, 0]]);
        assert!(reorder_parameter_sets(&f).is_none());
    }

    #[test]
    fn handles_three_byte_start_codes_and_multiple_slices() {
        let mut f = vec![0, 0, 1, 0x65, 9, 0, 0, 1, 0x65, 8];
        f.extend_from_slice(&[0, 0, 1, 0x67, 7, 0, 0, 1, 0x68, 6]);
        let fixed = reorder_parameter_sets(&f).unwrap();
        assert_eq!(fixed, annexb(&[&[0x67, 7], &[0x68, 6], &[0x65, 9], &[0x65, 8]]));
    }
}
