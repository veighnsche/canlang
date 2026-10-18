fn main() {
    std::process::exit(can_dev_server::app::run(std::env::args().skip(1).collect()) as i32);
}
