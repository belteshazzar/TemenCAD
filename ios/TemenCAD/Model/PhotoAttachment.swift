import UIKit

/// A photo the user attaches to a message: shown to the assistant downscaled (as the web app does) and
/// kept at full size so the assistant can put it in the project (save_attachment) for a lithophane or
/// heightmap.
struct PhotoAttachment: Identifiable, Equatable {
    let id = UUID()
    /// Full-size JPEG, upright: what save_attachment writes into the project.
    let original: Data
    let width: Int, height: Int
    /// What the model sees: at most 1568 px on the long edge (more is downscaled by the API anyway) and
    /// well under its 5 MB image limit.
    let shown: Data
    let shownWidth: Int, shownHeight: Int
    /// A small JPEG for the chat transcript.
    let thumbnail: Data

    static let maxEdge: CGFloat = 1568
    static let maxShownBytes = 3_500_000 // raw; base64 adds a third, the limit is 5 MB

    /// From any image the system can read (HEIC from the camera, PNG, JPEG): nil if it is not one.
    init?(imageData: Data) {
        guard let image = UIImage(data: imageData) else { return nil }
        self.init(image: image)
    }

    init?(image: UIImage) {
        let upright = Self.render(image, longEdge: max(image.size.width, image.size.height) * image.scale)
        guard let full = upright.jpegData(compressionQuality: 0.92) else { return nil }
        original = full
        width = Int(upright.size.width * upright.scale); height = Int(upright.size.height * upright.scale)
        let small = Self.render(upright, longEdge: min(Self.maxEdge, CGFloat(max(width, height))))
        var quality: CGFloat = 0.85
        var data = small.jpegData(compressionQuality: quality) ?? full
        while data.count > Self.maxShownBytes && quality > 0.3 {
            quality -= 0.15
            data = small.jpegData(compressionQuality: quality) ?? data
        }
        shown = data
        shownWidth = Int(small.size.width * small.scale); shownHeight = Int(small.size.height * small.scale)
        thumbnail = Self.render(upright, longEdge: 360).jpegData(compressionQuality: 0.7) ?? data
    }

    /// Redrawn upright (camera photos carry their rotation as metadata) at `longEdge` pixels, scale 1.
    private static func render(_ image: UIImage, longEdge: CGFloat) -> UIImage {
        let w = image.size.width * image.scale, h = image.size.height * image.scale
        let k = min(1, longEdge / max(w, h, 1))
        let size = CGSize(width: max(1, (w * k).rounded()), height: max(1, (h * k).rounded()))
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        return UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
    }

    /// "4032×3024 px, shown at 1568×1176", as the web app labels attachments.
    var sizeLabel: String {
        "\(width)×\(height) px" + (shownWidth != width ? ", shown at \(shownWidth)×\(shownHeight)" : "")
    }
}
