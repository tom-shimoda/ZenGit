#[cfg(target_os = "windows")]
mod platform {
    use std::os::windows::process::CommandExt;

    pub const CREATE_NO_WINDOW: u32 = 0x08000000;

    pub trait CommandCreationFlags {
        fn set_creation_flags(&mut self) -> &mut Self;
    }

    impl CommandCreationFlags for tokio::process::Command {
        fn set_creation_flags(&mut self) -> &mut Self {
            self.creation_flags(CREATE_NO_WINDOW)
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod platform {
    pub trait CommandCreationFlags {
        fn set_creation_flags(&mut self) -> &mut Self;
    }

    impl CommandCreationFlags for tokio::process::Command {
        fn set_creation_flags(&mut self) -> &mut Self {
            self // 何もしない
        }
    }
}

pub use platform::CommandCreationFlags;
