#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() -> Result<(), Box<dyn std::error::Error>> {
    orbyt_lib::run()
}
