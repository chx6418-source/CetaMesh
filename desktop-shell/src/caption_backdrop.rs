//! Bounded presentation pixels only: no paths, URLs, image decoders or Core access.
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::Value;

// Native acceptance must pass before this normal-path gate is enabled.
pub const ACCEPTED: bool = false;
pub const MAX_WIDTH: usize = 1024;
pub const MAX_HEIGHT: usize = 96;
const MAX_BYTES: usize = MAX_WIDTH * MAX_HEIGHT * 4;

pub fn enabled() -> bool {
    ACCEPTED || cfg!(debug_assertions) && std::env::var("CETAMESH_TEST_CAPTION_BACKDROP").as_deref() == Ok("1")
}

pub struct Bitmap {
    pub frame: String, pub width: i32, pub height: i32,
    pub normal: Vec<u8>, pub modal: Vec<u8>,
    /// Three 1024-pixel rows: left (top to bottom), right, bottom (left to right).
    pub edges: Option<(Vec<u8>, Vec<u8>)>,
}

impl Bitmap {
    pub fn pixels(&self, modal: bool) -> &[u8] { if modal { &self.modal } else { &self.normal } }
    pub fn color_at(&self, x: i32, y: i32, width: i32, height: i32, modal: bool) -> u32 {
        let px = (i64::from(x.max(0)) * i64::from(self.width) / i64::from(width.max(1))).min(i64::from(self.width - 1)) as usize;
        let py = (i64::from(y.max(0)) * i64::from(self.height) / i64::from(height.max(1))).min(i64::from(self.height - 1)) as usize;
        let offset = (py * self.width as usize + px) * 4;
        let data = self.pixels(modal);
        u32::from(data[offset + 2]) | u32::from(data[offset + 1]) << 8 | u32::from(data[offset]) << 16
    }
}

pub fn validate_shape(params: &Value) -> Result<(), String> {
    let root = params.as_object().filter(|row| row.len() == 1 && row.contains_key("surface")).ok_or("caption requires only surface")?;
    let surface = &root["surface"];
    if surface.is_null() { return Ok(()); }
    let row = surface.as_object().filter(|row| row.len() == 4 + usize::from(row.contains_key("edges")) && ["frame", "width", "height", "pixels"].iter().all(|key| row.contains_key(*key))).ok_or("invalid caption surface fields")?;
    if let Some(edges) = row.get("edges") {
        if edges.as_str().is_none_or(|data| data.len() != 1024 * 3 * 4 / 3 * 4) { return Err("invalid perimeter pixel length".into()); }
    }
    let frame = row["frame"].as_str().ok_or("invalid caption frame")?;
    if frame.is_empty() || frame.len() > 96 || !frame.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') { return Err("invalid caption frame".into()); }
    let width = row["width"].as_u64().filter(|n| *n > 0 && *n <= MAX_WIDTH as u64).ok_or("invalid caption width")? as usize;
    let height = row["height"].as_u64().filter(|n| *n > 0 && *n <= MAX_HEIGHT as u64).ok_or("invalid caption height")? as usize;
    let bytes = width.checked_mul(height).and_then(|n| n.checked_mul(4)).filter(|n| *n <= MAX_BYTES).ok_or("caption pixel budget exceeded")?;
    let encoded = row["pixels"].as_str().ok_or("caption pixels must be base64")?;
    if encoded.len() != bytes.div_ceil(3) * 4 { return Err("caption pixel length mismatch".into()); }
    Ok(())
}

pub fn parse(params: &Value) -> Result<Option<Bitmap>, String> {
    validate_shape(params)?;
    let row = &params["surface"];
    if row.is_null() { return Ok(None); }
    let width = row["width"].as_u64().unwrap() as usize;
    let height = row["height"].as_u64().unwrap() as usize;
    let rgba = STANDARD.decode(row["pixels"].as_str().unwrap()).map_err(|_| "invalid caption base64")?;
    if rgba.len() != width * height * 4 { return Err("caption pixel length mismatch".into()); }
    let (normal,modal)=convert_pixels(&rgba)?;
    let edges=if let Some(data)=row.get("edges") {
        let bytes=STANDARD.decode(data.as_str().unwrap()).map_err(|_| "invalid perimeter base64")?;
        if bytes.len()!=1024*3*4 { return Err("invalid perimeter pixel length".into()); }
        Some(convert_pixels(&bytes)?)
    } else { None };
    Ok(Some(Bitmap { frame: row["frame"].as_str().unwrap().to_owned(), width: width as i32, height: height as i32, normal, modal, edges }))
}

fn convert_pixels(rgba: &[u8]) -> Result<(Vec<u8>, Vec<u8>), String> {
    let mut normal = Vec::with_capacity(rgba.len()); let mut modal = Vec::with_capacity(rgba.len());
    for pixel in rgba.chunks_exact(4) {
        if pixel[3] != 255 { return Err("caption pixels must be opaque".into()); }
        normal.extend_from_slice(&[pixel[2], pixel[1], pixel[0], 255]);
        let dim = |channel: u8, tint: u8| (f64::from(channel) * 0.58 + f64::from(tint) * 0.42).round() as u8;
        modal.extend_from_slice(&[dim(pixel[2], 21), dim(pixel[1], 26), dim(pixel[0], 20), 255]);
    }
    Ok((normal,modal))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn request() -> Value { json!({"surface":{"frame":"1280-840-40-96","width":2,"height":1,"pixels":STANDARD.encode([12,34,56,255,210,220,230,255])}}) }
    #[test]
    fn exact_pixels_and_modal_tint() {
        let image = parse(&request()).unwrap().unwrap();
        assert_eq!(image.normal, [56,34,12,255,230,220,210,255]);
        assert_eq!(&image.modal[..4], [41,31,15,255]);
        assert_eq!(image.color_at(0,0,100,40,false), 0x0038220c);
        assert_eq!(image.color_at(99,39,100,40,false), 0x00e6dcd2);
        assert!(parse(&json!({"surface":null})).unwrap().is_none());
    }
    #[test]
    fn rejects_fields_dimensions_lengths_and_nonopaque_pixels() {
        let mut cases = vec![json!({}), json!({"surface":null,"path":"x"}), json!({"surface":{"url":"file:///x"}})];
        for (key,value) in [("frame",json!("https://x")),("width",json!(1025)),("height",json!(97)),("width",json!(0)),("width",json!(1.5)),("pixels",json!("data:image/png;base64,x")),("pixels",json!(STANDARD.encode([1,2,3,0,4,5,6,255])))] {
            let mut row=request(); row["surface"][key]=value; cases.push(row);
        }
        for row in cases { assert!(parse(&row).is_err()); }
    }
    #[test]
    fn maximum_surface_is_bounded_and_valid() {
        let data=vec![255u8;MAX_BYTES];
        let value=json!({"surface":{"frame":"max","width":MAX_WIDTH,"height":MAX_HEIGHT,"pixels":STANDARD.encode(&data),"edges":STANDARD.encode(vec![255;1024*3*4])}});
        let image=parse(&value).unwrap().unwrap();
        assert_eq!(image.normal.len(),MAX_BYTES); assert_eq!(image.modal.len(),MAX_BYTES);
        assert!(serde_json::to_vec(&value).unwrap().len()<900*1024);
    }
    #[test]
    fn perimeter_pixels_are_bounded_opaque_and_modal() {
        let mut value=request();
        value["surface"]["edges"]=json!(STANDARD.encode([12u8,34,56,255].repeat(1024*3)));
        let image=parse(&value).unwrap().unwrap();
        assert_eq!(&image.edges.as_ref().unwrap().0[..4], &[56,34,12,255]);
        assert_eq!(&image.edges.as_ref().unwrap().1[..4], &[41,31,15,255]);
        for data in [vec![255;4],vec![0;1024*3*4],vec![255;1024*3*4+4]] {
            value["surface"]["edges"]=json!(STANDARD.encode(data));
            assert!(parse(&value).is_err());
        }
    }
}
