//! VST3 plugins are Windows-only (see vst.rs); elsewhere the mic chain has none.

use serde_json::{json, Value};
use tauri::AppHandle;

#[derive(Clone, PartialEq, Debug)]
pub struct Want {
    pub id: String,
    pub path: String,
    pub cid: String,
    pub name: String,
    pub on: bool,
}

pub fn init(_app: AppHandle) {}
pub fn sync(_want: Vec<Want>, _rate: u32) {}
pub fn process(_buf: &mut [f32]) {}
pub fn status() -> Value {
    json!({})
}
pub fn scan() -> Result<Vec<Value>, String> {
    Ok(Vec::new())
}
pub fn describe(_path: String) -> Result<Vec<Value>, String> {
    Err("VST3 plugins only work on Windows".into())
}
pub fn open_editor(_id: String) -> Result<(), String> {
    Err("VST3 plugins only work on Windows".into())
}
pub fn shutdown() {}
