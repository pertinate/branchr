//! Small previews of uploaded images, so chat doesn't download a 10 MB photo to show it at
//! 400 px. Made once at upload time, off the async runtime.

use std::io::Cursor;

use image::{DynamicImage, ImageFormat, ImageReader, Limits};

/// Chat shows images in a 400×300 box; twice that keeps them sharp on HiDPI screens.
const BOX_W: u32 = 800;
const BOX_H: u32 = 600;
/// Images we keep in memory during upload to preview. Bigger ones show the original.
pub const MAX_SOURCE: usize = 40 * 1024 * 1024;
/// A source already this small and inside the box isn't worth a preview.
const SMALL: usize = 256 * 1024;

/// Content types we can preview. GIFs and animated WebP keep their animation in the original.
pub fn previewable(content_type: &str) -> bool {
    matches!(content_type, "image/png" | "image/jpeg" | "image/webp")
}

pub struct Thumb {
    pub bytes: Vec<u8>,
    pub content_type: &'static str,
    /// The source's real size, for when the client didn't report it.
    pub width: u32,
    pub height: u32,
}

/// Makes a preview of `src`, or `None` if it isn't worth one or can't be decoded.
pub fn make(src: &[u8]) -> Option<Thumb> {
    let mut reader = ImageReader::new(Cursor::new(src)).with_guessed_format().ok()?;
    if !matches!(reader.format(), Some(ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP)) {
        return None;
    }
    let mut limits = Limits::default();
    limits.max_image_width = Some(16384);
    limits.max_image_height = Some(16384);
    limits.max_alloc = Some(512 * 1024 * 1024);
    reader.limits(limits);
    let img = reader.decode().ok()?;
    let (width, height) = (img.width(), img.height());
    let fits = width <= BOX_W && height <= BOX_H;
    if fits && src.len() <= SMALL {
        return None;
    }
    let small = if fits { img } else { img.resize(BOX_W, BOX_H, image::imageops::FilterType::Triangle) };
    let mut out = Cursor::new(Vec::new());
    let content_type = if small.color().has_alpha() {
        // The image crate only writes lossless WebP; still far smaller than the source.
        DynamicImage::ImageRgba8(small.to_rgba8()).write_to(&mut out, ImageFormat::WebP).ok()?;
        "image/webp"
    } else {
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 80).encode_image(&DynamicImage::ImageRgb8(small.to_rgb8())).ok()?;
        "image/jpeg"
    };
    let bytes = out.into_inner();
    // A preview bigger than the original helps nobody.
    if bytes.len() >= src.len() {
        return None;
    }
    Some(Thumb { bytes, content_type, width, height })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode(img: DynamicImage, format: ImageFormat) -> Vec<u8> {
        let mut out = Cursor::new(Vec::new());
        img.write_to(&mut out, format).unwrap();
        out.into_inner()
    }

    fn noisy(w: u32, h: u32) -> image::RgbImage {
        image::RgbImage::from_fn(w, h, |x, y| image::Rgb([(x * 7 ^ y * 13) as u8, (x * y) as u8, (x + y * 3) as u8]))
    }

    #[test]
    fn big_photo_shrinks_to_jpeg() {
        let src = encode(DynamicImage::ImageRgb8(noisy(3000, 2000)), ImageFormat::Png);
        let t = make(&src).expect("preview");
        assert_eq!(t.content_type, "image/jpeg");
        assert_eq!((t.width, t.height), (3000, 2000));
        let back = image::load_from_memory(&t.bytes).unwrap();
        assert_eq!((back.width(), back.height()), (800, 533));
    }

    #[test]
    fn transparency_stays_webp() {
        let img = image::RgbaImage::from_fn(1600, 1600, |x, y| image::Rgba([(x ^ y) as u8, x as u8, y as u8, (x % 255) as u8]));
        let t = make(&encode(DynamicImage::ImageRgba8(img), ImageFormat::Png)).expect("preview");
        assert_eq!(t.content_type, "image/webp");
    }

    #[test]
    fn small_images_and_junk_get_none() {
        assert!(make(&encode(DynamicImage::ImageRgb8(noisy(64, 64)), ImageFormat::Png)).is_none());
        assert!(make(b"not an image").is_none());
    }
}
